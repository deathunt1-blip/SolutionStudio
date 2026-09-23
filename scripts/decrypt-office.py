"""Decrypt authorized OOXML documents entirely in memory; stdin is the only secret input."""
import base64
import io
import json
import logging
import struct
import sys
import zipfile

MAX_BYTES = 64 * 1024 * 1024
MAX_REQUEST_BYTES = ((MAX_BYTES + 2) // 3) * 4 + 32768
logging.disable(logging.CRITICAL)


def reply(**result):
    sys.stdout.write(json.dumps(result, ensure_ascii=True, separators=(",", ":")))


class LimitedBuffer(io.BytesIO):
    def write(self, data):
        if self.tell() + len(data) > MAX_BYTES:
            raise OverflowError()
        return super().write(data)


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            reply(ok=False, code="too_large")
            return
        request = json.loads(raw)
        password, encoded = request["password"], request["data"]
        if not isinstance(password, str) or len(password.encode("utf-8")) > 4096 or not isinstance(encoded, str):
            raise ValueError()
        data = base64.b64decode(encoded, validate=True)
    except Exception:
        reply(ok=False, code="invalid_request")
        return
    if len(data) > MAX_BYTES:
        reply(ok=False, code="too_large")
        return
    if zipfile.is_zipfile(io.BytesIO(data)):
        reply(ok=True, encrypted=False)
        return
    try:
        from msoffcrypto.format.ooxml import OOXMLFile
        from msoffcrypto.exceptions import InvalidKeyError, DecryptionError, FileFormatError
    except ImportError:
        reply(ok=False, code="missing_dependencies")
        return
    try:
        document = OOXMLFile(io.BytesIO(data))
        if not document.is_encrypted():
            reply(ok=True, encrypted=False)
            return
        if not password:
            reply(ok=False, code="incorrect_password")
            return
        # Refuse an advertised oversized result before the library allocates plaintext bytes.
        with document.file.openstream("EncryptedPackage") as package:
            size = package.read(8)
        if len(size) != 8:
            raise ValueError()
        if struct.unpack("<Q", size)[0] > MAX_BYTES:
            reply(ok=False, code="too_large")
            return
        document.load_key(password=password, verify_password=True)
        output = LimitedBuffer()
        document.decrypt(output, verify_integrity=True)
        plaintext = output.getvalue()
        if not zipfile.is_zipfile(io.BytesIO(plaintext)):
            raise ValueError()
        reply(ok=True, encrypted=True, data=base64.b64encode(plaintext).decode("ascii"))
    except InvalidKeyError:
        reply(ok=False, code="incorrect_password")
    except OverflowError:
        reply(ok=False, code="too_large")
    except (DecryptionError, NotImplementedError):
        reply(ok=False, code="unsupported_encryption")
    except (FileFormatError, ValueError, KeyError):
        reply(ok=False, code="invalid_office")
    except Exception:
        reply(ok=False, code="decryption_failed")


if __name__ == "__main__":
    main()
