import pytest
import json

from cartesi import abi

from cartesapp.utils import bytes2hex, hex2str, hex2bytes
from cartesapp.testclient import TestClient

from model import *

###
# Tests

# test application setup
@pytest.fixture(scope='module')
def app_client() -> TestClient:
    client = TestClient()
    return client

# test payload
@pytest.fixture()
def nop_gameplay_payload() -> Payload:
    return Payload(
        outhash=NOP_GAMEPLAY_OUTHASH,
        gameplay_log=NOP_GAMEPLAY_LOG
    )

# test payload
@pytest.fixture()
def gameplay_payload() -> Payload:
    return Payload(
        outhash=GAMEPLAY_OUTHASH,
        gameplay_log=GAMEPLAY_LOG
    )

@pytest.fixture()
def noplg_gameplay_payload() -> Payload:
    return Payload(
        outhash=LGNOP_GAMEPLAY_OUTHASH,
        gameplay_log=LGNOP_GAMEPLAY_LOG
    )

###
# tests receive

# test mutation
def test_should_fail_short_payload(
        app_client: TestClient):

    last_notice_n = len(app_client.rollup.notices)
    last_report_n = len(app_client.rollup.reports)
    app_client.send_advance(hex_payload="0x")

    assert not app_client.rollup.status
    assert len(app_client.rollup.notices) == last_notice_n
    assert len(app_client.rollup.reports) == last_report_n + 1

    report = app_client.rollup.reports[-1]['data']['payload']
    report_json = json.loads(hex2str(report))
    report_model = ErrorReport.parse_obj(report_json)
    assert report_model.error.code == STATUS_INPUT_ERROR

def test_should_fail_malformed_payload(
        app_client: TestClient):

    app_client.rollup.send_raw_advance(b'')

    # application exited
    assert not app_client.rollup.status

def test_should_fail_submit_short_gameplay(
        app_client: TestClient,
        nop_gameplay_payload: Payload):

    nop_gameplay_payload.gameplay_log = nop_gameplay_payload.gameplay_log[:-1]
    hex_payload = bytes2hex(abi.encode_model(nop_gameplay_payload,True))

    last_notice_n = len(app_client.rollup.notices)
    last_report_n = len(app_client.rollup.reports)
    app_client.send_advance(hex_payload=hex_payload)

    assert not app_client.rollup.status
    assert len(app_client.rollup.notices) == last_notice_n
    assert len(app_client.rollup.reports) == last_report_n + 1

    report = app_client.rollup.reports[-1]['data']['payload']
    report_json = json.loads(hex2str(report))
    report_model = ErrorReport.parse_obj(report_json)
    assert report_model.error.code == STATUS_INPUT_ERROR

def test_should_fail_submit_long_payload(
        app_client: TestClient,
        nop_gameplay_payload: Payload):

    nop_gameplay_payload.gameplay_log = b'0' * 2097152
    hex_payload = bytes2hex(abi.encode_model(nop_gameplay_payload,True))

    last_notice_n = len(app_client.rollup.notices)
    last_report_n = len(app_client.rollup.reports)
    app_client.send_advance(hex_payload=hex_payload)

    assert not app_client.rollup.status
    assert len(app_client.rollup.notices) == last_notice_n
    assert len(app_client.rollup.reports) == last_report_n

def test_should_fail_submit_long_gameplay(
        app_client: TestClient,
        gameplay_payload: Payload):

    gameplay_payload.gameplay_log = b'0' * (2097152 - 352) # 2MB sub headers and outhash
    hex_payload = bytes2hex(abi.encode_model(gameplay_payload,True))

    last_notice_n = len(app_client.rollup.notices)
    last_report_n = len(app_client.rollup.reports)
    app_client.send_advance(hex_payload=hex_payload)

    assert not app_client.rollup.status
    assert len(app_client.rollup.notices) == last_notice_n
    assert len(app_client.rollup.reports) == last_report_n + 1

    report = app_client.rollup.reports[-1]['data']['payload']
    report_json = json.loads(hex2str(report))
    report_model = ErrorReport.parse_obj(report_json)
    assert report_model.error.code == STATUS_INPUT_ERROR

def test_should_fail_submit_long_gameplay2(
        app_client: TestClient,
        nop_gameplay_payload: Payload):

    nop_gameplay_payload.gameplay_log = b'0' * (1048576 + 1) # 1MB + 1
    hex_payload = bytes2hex(abi.encode_model(nop_gameplay_payload,True))

    last_notice_n = len(app_client.rollup.notices)
    last_report_n = len(app_client.rollup.reports)
    app_client.send_advance(hex_payload=hex_payload)

    assert not app_client.rollup.status
    assert len(app_client.rollup.notices) == last_notice_n
    assert len(app_client.rollup.reports) == last_report_n + 1

    report = app_client.rollup.reports[-1]['data']['payload']
    report_json = json.loads(hex2str(report))
    report_model = ErrorReport.parse_obj(report_json)
    assert report_model.error.code == STATUS_INPUT_ERROR

def test_should_submit_invalid_gameplay(
        app_client: TestClient,
        nop_gameplay_payload: Payload):

    nop_gameplay_payload.gameplay_log = b'\x00' + nop_gameplay_payload.gameplay_log
    hex_payload = bytes2hex(abi.encode_model(nop_gameplay_payload,True))

    last_notice_n = len(app_client.rollup.notices)
    last_report_n = len(app_client.rollup.reports)
    app_client.send_advance(hex_payload=hex_payload)

    assert not app_client.rollup.status
    assert len(app_client.rollup.notices) == last_notice_n
    assert len(app_client.rollup.reports) == last_report_n + 1

    report = app_client.rollup.reports[-1]['data']['payload']
    report_json = json.loads(hex2str(report))
    report_model = ErrorReport.parse_obj(report_json)
    assert report_model.error.code == STATUS_VERIFICATION_ERROR

def test_should_submit_invalid_outhash(
        app_client: TestClient,
        nop_gameplay_payload: Payload):

    nop_gameplay_payload.outhash = NOP_GAMEPLAY_OUTHASH[:31] + b'\x00'
    hex_payload = bytes2hex(abi.encode_model(nop_gameplay_payload,True))

    last_notice_n = len(app_client.rollup.notices)
    last_report_n = len(app_client.rollup.reports)
    app_client.send_advance(hex_payload=hex_payload)

    assert not app_client.rollup.status
    assert len(app_client.rollup.notices) == last_notice_n
    assert len(app_client.rollup.reports) == last_report_n + 1

    report = app_client.rollup.reports[-1]['data']['payload']
    report_json = json.loads(hex2str(report))
    report_model = ErrorReport.parse_obj(report_json)
    assert report_model.error.code == STATUS_OUTHASH_ERROR

def test_should_submit_nop_gameplay(
        app_client: TestClient,
        nop_gameplay_payload: Payload):

    hex_payload = bytes2hex(abi.encode_model(nop_gameplay_payload,True))

    last_notice_n = len(app_client.rollup.notices)
    last_report_n = len(app_client.rollup.reports)
    app_client.send_advance(hex_payload=hex_payload)

    assert app_client.rollup.status
    assert len(app_client.rollup.notices) == last_notice_n + 1
    assert len(app_client.rollup.reports) == last_report_n

    # validate notice
    notice = app_client.rollup.notices[-1]['data']['payload']
    notice_bytes = hex2bytes(notice)
    notice_model = abi.decode_to_model(data=notice_bytes,model=VerificationNotice)
    assert notice_model.user == USER1
    assert notice_model.score == 99983

def test_should_submit_nop_gameplay_another_user(
        app_client: TestClient,
        nop_gameplay_payload: Payload):

    hex_payload = bytes2hex(abi.encode_model(nop_gameplay_payload,True))

    last_notice_n = len(app_client.rollup.notices)
    last_report_n = len(app_client.rollup.reports)
    app_client.send_advance(hex_payload=hex_payload, msg_sender=USER2)

    assert app_client.rollup.status
    assert len(app_client.rollup.notices) == last_notice_n + 1
    assert len(app_client.rollup.reports) == last_report_n

    # validate notice
    notice = app_client.rollup.notices[-1]['data']['payload']
    notice_bytes = hex2bytes(notice)
    notice_model = abi.decode_to_model(data=notice_bytes,model=VerificationNotice)
    assert notice_model.user == USER2
    assert notice_model.score == 99983

def test_should_submit_noplg_gameplay(
        app_client: TestClient,
        noplg_gameplay_payload: Payload):

    hex_payload = bytes2hex(abi.encode_model(noplg_gameplay_payload,True))

    last_notice_n = len(app_client.rollup.notices)
    last_report_n = len(app_client.rollup.reports)
    app_client.send_advance(hex_payload=hex_payload)

    assert app_client.rollup.status
    assert len(app_client.rollup.notices) == last_notice_n + 1
    assert len(app_client.rollup.reports) == last_report_n

    # validate notice
    notice = app_client.rollup.notices[-1]['data']['payload']
    notice_bytes = hex2bytes(notice)
    notice_model = abi.decode_to_model(data=notice_bytes,model=VerificationNotice)
    assert notice_model.user == USER1
    assert notice_model.score == 48226

def test_should_submit_gameplay(
        app_client: TestClient,
        gameplay_payload: Payload):

    hex_payload = bytes2hex(abi.encode_model(gameplay_payload,True))

    last_notice_n = len(app_client.rollup.notices)
    last_report_n = len(app_client.rollup.reports)
    app_client.send_advance(hex_payload=hex_payload)

    assert app_client.rollup.status
    assert len(app_client.rollup.notices) == last_notice_n + 1
    assert len(app_client.rollup.reports) == last_report_n

    # validate notice
    notice = app_client.rollup.notices[-1]['data']['payload']
    notice_bytes = hex2bytes(notice)
    notice_model = abi.decode_to_model(data=notice_bytes,model=VerificationNotice)
    assert notice_model.user == USER1
    assert notice_model.score == 109172

def test_should_submit_gameplay_another_user(
        app_client: TestClient,
        gameplay_payload: Payload):

    gameplay_payload.outhash = USER2_GAMEPLAY_OUTHASH
    hex_payload = bytes2hex(abi.encode_model(gameplay_payload,True))

    last_notice_n = len(app_client.rollup.notices)
    last_report_n = len(app_client.rollup.reports)
    app_client.send_advance(hex_payload=hex_payload, msg_sender=USER2)

    assert app_client.rollup.status
    assert len(app_client.rollup.notices) == last_notice_n + 1
    assert len(app_client.rollup.reports) == last_report_n

    # validate notice
    notice = app_client.rollup.notices[-1]['data']['payload']
    notice_bytes = hex2bytes(notice)
    notice_model = abi.decode_to_model(data=notice_bytes,model=VerificationNotice)
    assert notice_model.user == USER2
    assert notice_model.score == 107172

# test inspect
def test_should_receive_inspect_no_data(app_client: TestClient):
    app_client.send_inspect(hex_payload='0x')
    assert app_client.rollup.status

def test_should_receive_inspect_any_data(app_client: TestClient):
    app_client.send_inspect(hex_payload='0x00')
    assert app_client.rollup.status
