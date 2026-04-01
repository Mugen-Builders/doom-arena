#include <cstddef>
#include <cstdint>

#include <cctype>  // Necessário para tolower
#include <cerrno>  // errno
#include <cstdio>  // std::fprintf/stderr
#include <cstdlib> // std::strerror
#include <cstring> // std::strerror
#include <format>
#include <fstream> // file stream operations
#include <iomanip> // Required for std::hex, std::setw, std::setfill
#include <regex>
#include <sstream> // Required for std::stringstream
#include <string>  // for string class

#include <array> // std::array
#include <tuple> // std::ignore

extern "C" {
#include <fcntl.h>    // open
#include <sys/mman.h> // mmap/msync
#include <sys/stat.h> // stat
#include <sys/wait.h> // waitpid
#include <unistd.h>   // close/lseek

#include <libcmt/abi.h>
#include <libcmt/io.h>
#include <libcmt/rollup.h>
}

#define MERKLE_PATH "/mnt/merkle/merkle"
#define BE256_SIZE 32
#define BYTES32_SIZE 32
#define MIN_GAMEPLAY_LOG_SIZE 16
#define MAX_GAMEPLAY_LOG_SIZE 1048576
#define TEMPFILE_SIZE 20
#define CARTRIDGE_PATH "/cartridges/freedoom.sqfs"
#define MAX_ERROR_MESSAGE_LENGTH 256
#define MAX_ERROR_REPORT_LENGTH MAX_ERROR_MESSAGE_LENGTH + 50

#define DEBUG(X) log_debug(X)
#define ERROR(X) log_error(X, __FILE__, __LINE__)

namespace {

bool debug_enabled(void) {
  static bool checked = false;
  static bool enabled = false;

  if (!checked) {
    if (getenv("RIVES_LOG_LEVEL") != NULL) {
      std::string log_level = getenv("RIVES_LOG_LEVEL");
      std::transform(log_level.begin(), log_level.end(), log_level.begin(),
                     [](unsigned char c) { return std::tolower(c); });
      std::string trace_log_level = "trace";
      std::string debug_log_level = "debug";
      if (log_level == trace_log_level || log_level == debug_log_level) {
        enabled = true;
      }
    }
    checked = true;
  }

  return enabled;
}

bool error_enabled(void) {
  static bool checked = false;
  static bool enabled = false;

  if (!checked) {
    if (getenv("RIVES_LOG_LEVEL") != NULL) {
      std::string log_level = getenv("RIVES_LOG_LEVEL");
      std::transform(log_level.begin(), log_level.end(), log_level.begin(),
                     [](unsigned char c) { return std::tolower(c); });
      std::string trace_log_level = "trace";
      std::string debug_log_level = "debug";
      std::string warn_log_level = "warn";
      std::string error_log_level = "error";
      if (log_level == trace_log_level || log_level == debug_log_level ||
          log_level == warn_log_level || log_level == error_log_level) {
        enabled = true;
      }
    }
    checked = true;
  }

  return enabled;
}

static void log_debug(std::string expr) {
  if (debug_enabled()) {
    std::ignore = std::fprintf(stdout, "[rives] DEBUG %s\n", expr.c_str());
  }
}

static void log_error(std::string expr, const char *file, int line) {
  if (error_enabled()) {
    std::ignore = std::fprintf(stderr, "[rives] ERROR %s:%d %s\n", file, line,
                               expr.c_str());
  }
}

using be256 = std::array<uint8_t, BE256_SIZE>;

typedef struct wallet_address {
  uint8_t fix[BYTES32_SIZE - CMT_ABI_ADDRESS_LENGTH];
  uint8_t data[CMT_ABI_ADDRESS_LENGTH];
} wallet_address_t;

typedef struct bytes32 {
  uint8_t data[BYTES32_SIZE];
} bytes32_t;

bool operator==(const bytes32_t &a, const bytes32_t &b) {
  return std::equal(std::begin(a.data), std::end(a.data), std::begin(b.data));
}

////////////////////////////////////////////////////////////////////////////////
// Rollup utilities.

// Payload encoding gameplay inputs
struct [[gnu::packed]] gameplay_payload {
  bytes32_t outhash;
  char *gameplay_log;
};

// Payload encoding gameplay inputs
struct [[gnu::packed]] gameplay_notice {
  wallet_address_t user;
  be256 timestamp;
  be256 score;
  be256 input_index;
};

template <typename T>
[[nodiscard]]
constexpr cmt_abi_bytes_t payload_to_bytes(const T &payload) {
  DEBUG(std::format("payload_to_bytes size {}", sizeof(payload)));
  cmt_abi_bytes_t payload_bytes = {
      .length = sizeof(payload),
      .data = const_cast<T *>(
          &payload) // NOLINT(cppcoreguidelines-pro-type-const-cast)
  };
  return payload_bytes;
}

// Emit a report into rollup device.
[[nodiscard]]
bool rollup_emit_report(cmt_rollup_t *rollup,
                        const cmt_abi_bytes_t &payload_bytes) {
  const int err = cmt_rollup_emit_report(rollup, &payload_bytes);
  if (err < 0) {
    ERROR(std::format("unable to emit report: {}", std::strerror(-err)));
    return false;
  }
  return true;
}

// Emit a notice into rollup device.
[[nodiscard]]
bool rollup_emit_notice(cmt_rollup_t *rollup,
                        const cmt_abi_bytes_t &payload_bytes) {
  DEBUG(std::format("notice payload bytes length {}", payload_bytes.length));
  const int err = cmt_rollup_emit_notice(rollup, &payload_bytes, nullptr);
  if (err < 0) {
    ERROR(std::format("unable to emit notice: {}", std::strerror(-err)));
    return false;
  }
  return true;
}

// Finish last rollup request, wait for next rollup request and process it.
// For every new request, reads an input POD and call backs its respective
// advance or inspect state handler.
template <typename ADVANCE_STATE, typename INSPECT_STATE>
[[nodiscard]]
bool rollup_process_next_request(cmt_rollup_t *rollup,
                                 ADVANCE_STATE advance_state,
                                 INSPECT_STATE inspect_state,
                                 bool last_request_status) {

  // Finish previous request and wait for the next request.
  DEBUG(std::format("finishing previous request with status {}",
                    last_request_status));
  cmt_rollup_finish_t finish{.accept_previous_request = last_request_status};
  sync(); // ensure data is written to disk
  const int err = cmt_rollup_finish(rollup, &finish);
  if (err < 0) {
    ERROR(std::format("unable to perform rollup finish: {}",
                      std::strerror(-err)));
    return false;
  }

  // Handle request
  switch (finish.next_request_type) {
  case HTIF_YIELD_REASON_ADVANCE: { // Advance state.
    return advance_state(rollup);
  }
  case HTIF_YIELD_REASON_INSPECT: { // Inspect state.
    // Call inspect state handler.
    return inspect_state(rollup);
  }
  default: { // Invalid request.
    ERROR("invalid request type");
    return false;
  }
  }
}

////////////////////////////////////////////////////////////////////////////////
// Rives barebones application.

// Status code sent in reports
enum handle_status : uint8_t {
  STATUS_SUCCESS = 0,
  STATUS_INPUT_ERROR = 1,
  STATUS_NOTICE_ERROR = 2,
  STATUS_FILE_ERROR = 3,
  STATUS_FORK_ERROR = 4,
  STATUS_VERIFICATION_ERROR = 5,
  STATUS_OUTHASH_ERROR = 6,
  STATUS_OUTCARD_ERROR = 7,
  STATUS_RUNTIME_EXCEPTION = 8,
  STATUS_UNKNOWN_EXCEPTION = 9,
};

char *rives_report_payload(handle_status status, const char *message,
                           size_t *bytes_written) {
  static char payload[MAX_ERROR_REPORT_LENGTH];
  int written =
      snprintf(payload, MAX_ERROR_REPORT_LENGTH,
               "{\"error\":{\"code\":%d,\"message\":\"%s\"}}", status, message);
  *bytes_written = written > 0 ? written : 0;
  return payload;
}

// Custom exception class
class RivesException : public std::exception {
private:
  std::string message;
  handle_status errorCode;

public:
  // Constructor to initialize message and error code
  RivesException(const std::string &msg, handle_status code)
      : message(msg), errorCode(code) {}

  // Override the what() method to return the error message
  virtual const char *what() const noexcept override { return message.c_str(); }

  // Method to get the custom error code
  handle_status code() const noexcept { return errorCode; }
};

struct unique_temp_file {
  explicit unique_temp_file(const char *patt, size_t length) {
    strncpy(path, patt, length);
    fd = mkstemp(path);
  }
  ~unique_temp_file() {
    if (fd >= 0) {
      close(fd);
      unlink(path);
    }
  }
  char path[TEMPFILE_SIZE];
  int fd;
};

// Process gameplay validation
void process_verification(cmt_rollup_t *rollup,
                          const cmt_rollup_advance_t &input) {

  // Step 1: Validate input (size)
  if (input.payload.length < BYTES32_SIZE + MIN_GAMEPLAY_LOG_SIZE) {
    throw RivesException("payload size too small", STATUS_INPUT_ERROR);
  }
  if (input.payload.length > MAX_GAMEPLAY_LOG_SIZE) {
    throw RivesException("payload size too large", STATUS_INPUT_ERROR);
  }

  // Step 2: Validate gameplay log
  // Step 2.1: get user address and convert to hex to use as entropy
  std::stringstream msg_sender_ss;
  msg_sender_ss << std::hex;
  msg_sender_ss << "0x";
  for (int i(0); i < CMT_ABI_ADDRESS_LENGTH; ++i)
    msg_sender_ss << std::setw(2) << std::setfill('0')
                  << static_cast<int>(input.msg_sender.data[i]);
  DEBUG(std::format("Msg sender: {}", msg_sender_ss.str().c_str()));

  // Step 2.2: prepare temp files
  //
  unique_temp_file outcard_file("/run/outcardXXXXXX", TEMPFILE_SIZE);
  if (outcard_file.fd == -1) {
    throw RivesException("error opening outcard temp file", STATUS_FILE_ERROR);
  }
  if (close(outcard_file.fd) == -1) {
    throw RivesException("error closing outcard temp file", STATUS_FILE_ERROR);
  }

  unique_temp_file outhash_file("/run/outhashXXXXXX", TEMPFILE_SIZE);
  if (outhash_file.fd == -1) {
    throw RivesException("error opening outhash temp file", STATUS_FILE_ERROR);
  }
  if (close(outhash_file.fd) == -1) {
    throw RivesException("error closing outhash temp file", STATUS_FILE_ERROR);
  }

  unique_temp_file gameplay_log_file("/run/gamelogXXXXXX", TEMPFILE_SIZE);
  if (gameplay_log_file.fd == -1) {
    throw RivesException("error opening gameplay log temp file",
                         STATUS_FILE_ERROR);
  }

  // define variables needed outside try scope
  std::string outcard_str;

  // Step 2.3: save gameplay log in temp file

  // Write the gameplay log to the temporary file
  ssize_t bytes_to_write = input.payload.length - BYTES32_SIZE;
  ssize_t bytes_written =
      write(gameplay_log_file.fd,
            reinterpret_cast<const char *>(input.payload.data) + BYTES32_SIZE,
            bytes_to_write);
  if (bytes_written != bytes_to_write) {
    throw RivesException("error writing to gameplay log temp file",
                         STATUS_FILE_ERROR);
  }
  if (close(gameplay_log_file.fd) == -1) {
    throw RivesException("error closing gameplay log temp file",
                         STATUS_FILE_ERROR);
  }

  // Step 2.4: set up and run verification

  pid_t pid = fork();

  if (pid == -1) {
    throw RivesException("failed to fork", STATUS_FORK_ERROR);
  } else if (pid == 0) {
    // child

    DEBUG(std::format(
        "full cmd: /rivos/usr/sbin/riv-chroot /rivos --setenv "
        "RIV_CARTRIDGE {} --setenv RIV_REPLAYLOG {} --setenv RIV_OUTCARD {} "
        "--setenv RIV_OUTHASH {} --setenv RIV_NO_YIELD y --setenv "
        "RIV_ENTROPY "
        "{} "
        "riv-run",
        CARTRIDGE_PATH, gameplay_log_file.path, outcard_file.path,
        outhash_file.path, msg_sender_ss.str().c_str()));

    if (!debug_enabled()) {
      int fd = open("/dev/null", O_WRONLY);
      if (fd == -1) {
        throw RivesException("failed to open /dev/null to suppress stdout",
                             STATUS_FILE_ERROR);
      }
      dup2(fd, STDOUT_FILENO); // Redirect stdout to /dev/null
    }
    const int err =
        execl("/rivos/usr/sbin/riv-chroot", "/rivos/usr/sbin/riv-chroot",
              "/rivos", "--setenv", "RIV_CARTRIDGE", CARTRIDGE_PATH, "--setenv",
              "RIV_REPLAYLOG", gameplay_log_file.path, "--setenv",
              "RIV_OUTCARD", outcard_file.path, "--setenv", "RIV_OUTHASH",
              outhash_file.path, "--setenv", "RIV_NO_YIELD", "y", "--setenv",
              "RIV_ENTROPY", msg_sender_ss.str().c_str(), "riv-run", NULL);

    if (err != 0) {
      ERROR(std::format("error running verification: {}", std::strerror(-err)));
      _exit(STATUS_VERIFICATION_ERROR);
    }

    _exit(STATUS_SUCCESS);
  }

  int status;
  waitpid(pid, &status, 0);
  DEBUG(std::format("wait status: {} ({}, {})", status, WIFEXITED(status),
                    WEXITSTATUS(status)));

  if (!WIFEXITED(status) || WEXITSTATUS(status) != STATUS_SUCCESS) {
    throw RivesException("error running verification",
                         STATUS_VERIFICATION_ERROR);
  }

  // Step 3: get outhash and compare with input outhash
  std::ifstream outhash_filefs(outhash_file.path);
  if (!outhash_filefs.is_open()) {
    throw RivesException("error opening outhash file", STATUS_FILE_ERROR);
  }
  std::string outhash_hex_str;
  std::getline(outhash_filefs, outhash_hex_str);
  outhash_filefs.close();

  bytes32_t verification_outhash;
  bytes32_t payload_outhash;
  const uint8_t *payload_data =
      reinterpret_cast<const uint8_t *>(input.payload.data);
  // Loop through the hex string, two characters at a time
  for (size_t i = 0; i < BYTES32_SIZE; i += 1) {
    std::string byteString = outhash_hex_str.substr(2 * i, 2);
    uint8_t byteValue =
        static_cast<uint8_t>(std::stoi(byteString, nullptr, 16));
    verification_outhash.data[i] = byteValue;
    payload_outhash.data[i] = payload_data[i];
  }

  if (!(payload_outhash == verification_outhash)) {
    std::string err_msg = "error outhash mismatch, obtained ";
    err_msg += outhash_hex_str.c_str();
    throw RivesException(err_msg.c_str(), STATUS_OUTHASH_ERROR);
  }

  // Step 4: Get outcard and extract score
  std::ifstream outcard_filefs(outcard_file.path);
  if (!outcard_filefs.is_open()) {
    throw RivesException("error opening outcard file", STATUS_FILE_ERROR);
  }
  std::stringstream outcard_buffer;
  outcard_buffer << outcard_filefs.rdbuf();
  outcard_str = outcard_buffer.str();

  outcard_filefs.close();

  DEBUG(std::format("outcard: {}", outcard_str.c_str()));

  // Step 5: cleanup temp files
  // done in unique_temp_file class destructor

  // Step 6: prepare TO emit notice
  static const std::regex score_pattern(R"("score":\s*(\d+)\s*,)");
  std::smatch score_matches;

  DEBUG("looking for score matches from outcard file");

  if (!std::regex_search(outcard_str, score_matches, score_pattern) ||
      !score_matches.ready() || score_matches.size() < 2) {
    throw RivesException("error getting score from outcard file",
                         STATUS_OUTCARD_ERROR);
  }

  DEBUG(std::format("found score matches={}", score_matches.size()));
  DEBUG(std::format("full match: {}", score_matches[0].str().c_str()));
  DEBUG(std::format("group 1: {}", score_matches[1].str().c_str()));

  int64_t score = std::stoi(score_matches[1].str());

  gameplay_notice notice{};
  memcpy(notice.user.data, input.msg_sender.data, CMT_ABI_ADDRESS_LENGTH);

  for (size_t i = 0; i < sizeof(score); i++) {
    const size_t j = BYTES32_SIZE - i - 1;
    notice.score[j] = (score >> (i * 8)) & 0xFF;
    notice.input_index[j] = (input.index >> (i * 8)) & 0xFF;
    notice.timestamp[j] = (input.block_timestamp >> (i * 8)) & 0xFF;
  }
  if (score < 0) {
    for (size_t i = 0; i < BYTES32_SIZE - sizeof(score); i++) {
      notice.score[i] = 0xFF;
    }
  }

  // Step 7: emit notice (can't revert after, so no errors from here on)

  DEBUG("Sending notice");
  DEBUG(std::format("notice size {}", sizeof(notice)));

  const cmt_abi_bytes_t notice_bytes = {.length = sizeof(notice),
                                        .data = &notice};
  if (!rollup_emit_notice(rollup, notice_bytes)) {
    throw RivesException("error emitting notice", STATUS_NOTICE_ERROR);
  }
}

// Process advance state requests
bool advance_state(cmt_rollup_t *rollup) {
  try {
    // Read the input.
    DEBUG("advance request");
    cmt_rollup_advance_t input{};
    const int err = cmt_rollup_read_advance_state(rollup, &input);
    if (err < 0) {
      ERROR(
          std::format("unable to read advance state: {}", std::strerror(-err)));
      ERROR("forcing exit");
      exit(-EINVAL); // force exit. Exceptional error
    }

    DEBUG(std::format("advance request with size {}", input.payload.length));

    process_verification(rollup, input);
    ERROR("gameplay verified");

  } catch (const RivesException &e) {
    ERROR(std::format("rives exception caught: ({}) {}",
                      static_cast<uint8_t>(e.code()), e.what()));
    size_t report_length;
    char *report_payload =
        rives_report_payload(e.code(), e.what(), &report_length);
    if (report_length > 0 && report_length < MAX_ERROR_REPORT_LENGTH &&
        report_payload != nullptr) {
      const cmt_abi_bytes_t report_bytes = {.length = report_length,
                                            .data = report_payload};
      std::ignore = rollup_emit_report(rollup, report_bytes);
    }
    return false;
  } catch (const std::exception &e) {
    ERROR(std::format("exception caught: {}", e.what()));
    size_t report_length;
    char *report_payload = rives_report_payload(STATUS_RUNTIME_EXCEPTION,
                                                e.what(), &report_length);
    if (report_length > 0 && report_length < MAX_ERROR_REPORT_LENGTH &&
        report_payload != nullptr) {
      const cmt_abi_bytes_t report_bytes = {.length = report_length,
                                            .data = report_payload};
      std::ignore = rollup_emit_report(rollup, report_bytes);
    }
    return false;
  } catch (...) {
    ERROR("unknown exception caught");
    size_t report_length;
    char *report_payload = rives_report_payload(
        STATUS_UNKNOWN_EXCEPTION, "unknown exception caught", &report_length);
    if (report_length > 0 && report_length < MAX_ERROR_REPORT_LENGTH &&
        report_payload != nullptr) {
      const cmt_abi_bytes_t report_bytes = {.length = report_length,
                                            .data = report_payload};
      std::ignore = rollup_emit_report(rollup, report_bytes);
    }
    return false;
  }
  return true;
}

// Ignore inspect state queries
bool inspect_state(cmt_rollup_t *rollup) {
  // Inspect balance.
  cmt_rollup_inspect_t input{};
  const int err = cmt_rollup_read_inspect_state(rollup, &input);
  if (err < 0) {
    ERROR(std::format("unable to read inspect state: {}", std::strerror(-err)));
    return false;
  }
  DEBUG(std::format("inspect request with size {}", input.payload.length));

  DEBUG("inspect ignored");
  return true;
}
}; // anonymous namespace

// Application main.
int main() {
  cmt_rollup_t rollup{};
  // Disable buffering of stderr to avoid dynamic allocations behind the scenes
  if (std::setvbuf(stderr, nullptr, _IONBF, 0) != 0) {
    ERROR(std::format("unable to disable stderr buffering: {}",
                      std::strerror(errno)));
    return -1;
  }

  // Initialize rollup device.
  const int err = cmt_rollup_init(&rollup);
  if (err != 0) {
    ERROR(std::format("unable to initialize rollup device: {}",
                      std::strerror(-err)));
    return -1;
  }

  struct stat buffer;
  if (stat(MERKLE_PATH, &buffer) == 0) {
    const int err_merkle = cmt_rollup_load_merkle(&rollup, MERKLE_PATH);
    if (err_merkle != 0) {
      ERROR(std::format("unable to load merkle tree: {}",
                        std::strerror(-err_merkle)));
      return -1;
    }
  }

  // Process requests forever.
  DEBUG("processing rollup requests...\n");
  bool last_request_status = true;
  while (true) {
    if (last_request_status) {
      mode_t original_umask = umask(0000);
      const int err_merkle = cmt_rollup_save_merkle(&rollup, MERKLE_PATH);
      if (err_merkle != 0) {
        ERROR(std::format("unable to save merkle tree: {}",
                          std::strerror(-err_merkle)));
        return -1;
      }
      umask(original_umask);
    }

    last_request_status = rollup_process_next_request(
        &rollup, advance_state, inspect_state, last_request_status);
  }
  // Unreachable code, return is intentionally omitted.
}
