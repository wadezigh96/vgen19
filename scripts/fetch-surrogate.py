#!/usr/bin/env python3
"""Fetch one fresh credential surrogate from authd and print it.

Usage: fetch-surrogate.py <credential-name>

Prints ONLY the surrogate value (an ``hsurr:...`` string) to stdout,
nothing else, so the caller can capture it into an environment
variable for one run. All errors go to stderr and exit non-zero.

The real keys live in the Muse Secure Vault and are never in a file
or an environment variable: this helper returns a surrogate, and the
runtime swaps it for the real key on egress to the registered host.
Never write the output to a file or a log.

The authd helper module is imported from PYTHONPATH first (tests
point it at a stub), falling back to the bundled helper directory
(``DYNAMIC_CREDENTIALS_BIN``, default
``/opt/muse/skills/custom-connector-setup/bin``).
"""

from __future__ import annotations

import os
import sys

DEFAULT_BIN_DIR = "/opt/muse/skills/custom-connector-setup/bin"


def _load_module():
    """Import the dynamic_credentials helper, with a bin-dir fallback."""
    try:
        import dynamic_credentials

        return dynamic_credentials
    except ImportError:
        bin_dir = os.environ.get("DYNAMIC_CREDENTIALS_BIN", DEFAULT_BIN_DIR)
        if bin_dir and bin_dir not in sys.path:
            sys.path.append(bin_dir)
        import dynamic_credentials

        return dynamic_credentials


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(
            "usage: fetch-surrogate.py <credential-name>",
            file=sys.stderr,
        )
        return 2
    credential_name = argv[1]
    try:
        module = _load_module()
    except ImportError as exc:
        print(
            f"error: failed to fetch surrogate for {credential_name}: "
            f"could not import the authd helper module ({exc})",
            file=sys.stderr,
        )
        return 1
    try:
        entry = module.dynamic_credential_entry(credential_name)
        if not isinstance(entry, dict):
            raise ValueError(
                "authd returned a non-dict entry "
                f"({type(entry).__name__})"
            )
        surrogate = str(entry.get("surrogate", "")).strip()
    except Exception as exc:  # noqa: BLE001 - authd errors are reported, not raised
        print(
            f"error: failed to fetch surrogate for {credential_name}: {exc}",
            file=sys.stderr,
        )
        return 1
    if not surrogate.startswith("hsurr:"):
        print(
            f"error: failed to fetch surrogate for {credential_name}: "
            "authd returned a value that is not a surrogate",
            file=sys.stderr,
        )
        return 1
    # The only thing this script ever prints to stdout.
    print(surrogate)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
