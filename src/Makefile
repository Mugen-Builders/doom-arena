# C++ compiler
CXX = gcc

# C++ warning flags
WARN_CXXFLAGS = -Wall -Wextra -Wpedantic -Wformat -Werror=format-security -Wno-missing-field-initializers

# C++ optimization flags, use -O1 to be safe of GCC compiler optimizer bugs
OPT_CXXFLAGS = -O1

# C++ flags to improve safety
HARDEN_CXXFLAGS = \
	-fhardened \
	-fno-strict-aliasing \
	-fno-strict-overflow

HARDEN2_CXXFLAGS = \
	-fno-rtti

# Use C++20, without exceptions and RTTI to have minimal overhead and predictable behavior
CXXFLAGS += \
	-std=c++20 \
	-fexceptions \
	$(WARN_CXXFLAGS) \
	$(OPT_CXXFLAGS)

# Use libcmt for CMIO device control
LIBS = -l:libcmt.a -lstdc++

# Linker flags to improve safety
LDFLAGS += -Wl,--build-id=none -static-libstdc++ -static-libgcc

# Current architecture
ARCH := $(shell uname -m)


CONFIG_ENV = localhost
INCS += -I./config/${CONFIG_ENV}
ifneq ($(ARCH),riscv64)
# For linting in the host
LINTER_INCS += -I./libcmt/include
endif

OUT_DIR ?= dist

# ARTIFACTS = send_msg receive_msg
ARTIFACTS = rives-barebones
SOURCES = $(addsuffix .cpp,$(ARTIFACTS))

BUILDER_IMAGE = rives-barebones-builder

all: $(ARTIFACTS)
SOURCES = $(addsuffix .cpp,$(ARTIFACTS))

%.cpp: $(addsuffix ,%)

%: %.cpp $(OUT_DIR)
	$(CXX) $(CXXFLAGS) $(HARDEN_CXXFLAGS) $(HARDEN2_CXXFLAGS) $(INCS) -o $(OUT_DIR)/$@ $< $(LDFLAGS) $(LIBS)

$(OUT_DIR):
	mkdir -p $@

ifneq ($(ARCH),riscv64)
builder-image:
	docker build --platform linux/riscv64 -f app.dockerfile -t $(BUILDER_IMAGE) --target builder .
build: builder-image
	docker run --platform linux/riscv64 --rm -v $(PWD)/src:/app -w /app -u $(shell id -u):$(shell id -g) $(BUILDER_IMAGE) make $(ARGS)
else
build: all
endif

# # Machine entrypoint
# MACHINE_ENTRYPOINT = exec /home/dapp/rives-barebones

# # Machine initial kernel and flash drives
# MACHINE_FLAGS = \
# 	--ram-image=linux.bin \
# 	--flash-drive=label:root,filename:rootfs.ext2 \
# 	--flash-drive=label:state,length:4096

# snapshot: rootfs.ext2 linux.bin ## Generate cartesi machine genesis snapshot
# 	rm -rf snapshot
# 	cartesi-machine $(MACHINE_FLAGS) --assert-rolling-template --final-hash --store=$@ -- $(MACHINE_ENTRYPOINT)

lint: lint-cpp

lint-cpp: $(SOURCES) $(HEADERS) ## Lint C++ code
	clang-tidy $^ -- $(CXXFLAGS) $(INCS) $(LINTER_INCS)

format: format-cpp

format-cpp: $(SOURCES) ## Format C++ code
	clang-format -i $^

clean: ## Clean generated files
	rm -rf dist

clean-builder-image: ## Clean builder-image
	docker rmi $(BUILDER_IMAGE)

distclean: clean ## Clean generated and downloaded files

help: ## Show this help
	@sed \
		-e '/^[a-zA-Z0-9_\-]*:.*##/!d' \
		-e 's/:.*##\s*/:/' \
		-e 's/^\(.\+\):\(.*\)/$(shell tput setaf 6)\1$(shell tput sgr0):\2/' \
		$(MAKEFILE_LIST) | column -c2 -t -s :

.PHONY: all lint lint-cpp format format-cpp clean distclean help
