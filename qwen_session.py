#!/usr/bin/env python3
"""
qwen_session.py — generate a signed-in chat.qwen.ai session via the API.

Usage:
  # API flows — official auth endpoints, session saved to j49_c.txt:
  python qwen_session.py signup --email you@example.com --password SECRET [--name "You"]
  python qwen_session.py signin --email you@example.com [--password SECRET]
  python qwen_session.py otp-request --email you@example.com
  python qwen_session.py otp-verify --email you@example.com --code 123456

  # Browser-export flow (fallback, mirrors src/session.js):
  python qwen_session.py auth-import "<cookie string or session JSON>"
  python qwen_session.py status          # is j49_c.txt signed in?
  python qwen_session.py export          # print Cookie/Authorization headers

Limits (same as README): this tool calls the official endpoints only. It does
NOT solve the Aliyun WAF / Alibaba anti-bot challenge — when the WAF answers
a POST with its captcha page, the command fails with a clear message and the
fallback is a one-time browser sign-in + `auth-import`.

Output file format (UTF-8 JSON, accepted by src/cli.js auth-import):
  { "cookieString": "a=b; c=d", "token": "...", "verified": {...} }

Cookie values are never printed by `status`; use `export` when you actually
need them.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from urllib import error as urlerror
from urllib import request as urlrequest

AUTH_URL = "https://auth.qwen.ai/api/v2/auths/"
REFRESH_URL = "https://auth.qwen.ai/api/v2/auths/refresh"
SIGNUP_URL = "https://auth.qwen.ai/api/v2/auths/signup"
SIGNIN_URL = "https://auth.qwen.ai/api/v2/auths/signin"
OTP_REQUEST_URL = "https://auth.qwen.ai/api/v2/auths/otp/email/request"
OTP_VERIFY_URL = "https://auth.qwen.ai/api/v2/auths/otp/email/verify"
DEFAULT_FILE = "j49_c.txt"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
# Interstitial markers as in src/client.js (Alibaba TMD challenge), plus the
# Aliyun WAF captcha page that answers API POSTs from flagged networks.
CHALLENGE_MARKERS = (
    "_____tmd_____",
    "punishTextFetch",
    "x5secdata",
    "gridConnectGet",
    "aliyun_waf_aa",
    "aliyunCaptcha",
)


class SessionError(Exception):
    """Recoverable failure with a user-facing message."""


class AntiBotChallenge(SessionError):
    def __init__(self, marker: str):
        super().__init__(
            f"anti-bot challenge in response body (marker: {marker}) — "
            "this tool does not solve WAF/TMD challenges; fall back to a "
            "one-time browser sign-in + `auth-import`"
        )
        self.marker = marker


# --------------------------------------------------------------------------- #
# cookies
# --------------------------------------------------------------------------- #

def parse_cookie_string(raw: str) -> dict[str, str]:
    """Parse a `document.cookie` style string into a dict."""
    cookies: dict[str, str] = {}
    for part in raw.split(";"):
        idx = part.find("=")
        if idx < 1:
            continue
        cookies[part[:idx].strip()] = part[idx + 1 :].strip()
    return cookies


def cookie_header(cookies: dict[str, str]) -> str:
    return "; ".join(f"{k}={v}" for k, v in cookies.items())


def absorb_set_cookie(cookies: dict[str, str], raw: str) -> None:
    """Merge one Set-Cookie header; Max-Age<=0 deletes the cookie."""
    pair, _, attrs = raw.partition(";")
    idx = pair.find("=")
    if idx < 1:
        return
    name, value = pair[:idx].strip(), pair[idx + 1 :].strip()
    if value == "":
        cookies.pop(name, None)
        return
    for attr in attrs.split(";"):
        key, _, val = attr.strip().partition("=")
        if key.lower() == "max-age":
            try:
                if int(val) <= 0:
                    cookies.pop(name, None)
            except ValueError:
                pass
            return
    cookies[name] = value


# --------------------------------------------------------------------------- #
# HTTP (mirrors src/client.js: effective status, challenge scan, refresh)
# --------------------------------------------------------------------------- #

def base_headers() -> dict[str, str]:
    return {
        "accept": "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.9",
        "origin": "https://chat.qwen.ai",
        "referer": "https://chat.qwen.ai/",
        "user-agent": UA,
        "x-request-id": str(uuid.uuid4()),
    }


def detect_challenge(text: str) -> str | None:
    for marker in CHALLENGE_MARKERS:
        if marker in text:
            return marker
    return None


def effective_status(resp) -> int:
    """The gateway answers 200 on the wire; the real status rides in
    `x-actual-status-code` (see src/client.js -> effectiveStatus)."""
    hdr = resp.headers.get("x-actual-status-code")
    if hdr is not None:
        try:
            return int(hdr)
        except ValueError:
            pass
    return getattr(resp, "status", None) or getattr(resp, "code", 0) or 0


def http(
    cookies: dict[str, str],
    token: str | None,
    url: str,
    method: str = "GET",
    body=None,
    timeout: float = 30.0,
) -> tuple[int, str]:
    headers = base_headers()
    cookie = cookie_header(cookies)
    if cookie:
        headers["cookie"] = cookie
    if token:
        headers["authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"

    req = urlrequest.Request(url, data=data, method=method, headers=headers)
    try:
        resp = urlrequest.urlopen(req, timeout=timeout)
    except urlerror.HTTPError as e:
        resp = e
    except urlerror.URLError as e:
        raise SessionError(f"network error contacting {url}: {e.reason}") from e

    with resp:
        text = resp.read().decode("utf-8", "replace")
        status = effective_status(resp)
        for sc in resp.headers.get_all("Set-Cookie") or []:
            absorb_set_cookie(cookies, sc)

    marker = detect_challenge(text)
    if marker:
        raise AntiBotChallenge(marker)
    return status, text


def refresh(cookies: dict[str, str]) -> None:
    """Best-effort cookie refresh, same endpoint as src/client.js #refresh."""
    try:
        http(cookies, None, REFRESH_URL)
    except SessionError:
        pass


def verify(cookies: dict[str, str], token: str | None) -> tuple[dict | None, str | None]:
    """Check the session against the live auth endpoint.

    Returns (account_data, None) on success or (None, reason) on failure.
    """
    if not cookies:
        return None, "no cookies to check"
    try:
        status, text = http(cookies, token, AUTH_URL)
        if status == 401:
            refresh(cookies)
            status, text = http(cookies, token, AUTH_URL)
    except SessionError as e:
        return None, str(e)

    if status == 401:
        return None, "401 — session expired or not signed in"
    if status >= 400:
        return None, f"HTTP {status} from auth endpoint"

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return None, f"non-JSON response (status {status})"

    if isinstance(parsed, dict) and parsed.get("success") is False:
        inner = parsed.get("data") or {}
        code = inner.get("code") if isinstance(inner, dict) else None
        return None, f"request failed: {code or 'unknown code'}"

    data = parsed.get("data", parsed) if isinstance(parsed, dict) else parsed
    if isinstance(data, dict) and (data.get("id") or data.get("user_id")):
        return data, None
    return None, "signed out (guest session)"


# --------------------------------------------------------------------------- #
# file I/O
# --------------------------------------------------------------------------- #

def load(path: str) -> tuple[dict[str, str], str | None, dict]:
    if not os.path.isfile(path):
        raise SessionError(f"{path} not found — run `auth-import` first")
    try:
        raw = json.loads(open(path, encoding="utf-8").read())
    except json.JSONDecodeError as e:
        raise SessionError(f"{path} is not valid JSON: {e}") from e
    if not isinstance(raw, dict):
        raise SessionError(f"{path} must contain a JSON object")

    cookies = dict(raw.get("cookies") or {})
    if not cookies and raw.get("cookieString"):
        cookies = parse_cookie_string(raw["cookieString"])
    token = raw.get("token") or raw.get("accessToken") or None
    if not cookies:
        raise SessionError(f"{path} contains no cookies")
    return cookies, token, raw


def save(path: str, cookies: dict[str, str], token: str | None, verified: dict | None) -> str:
    # `cookieString` + `token` (not `cookies` + `accessToken`) so that
    # src/cli.js auth-import routes through importSessionJson and keeps the
    # bearer token alongside the cookies.
    payload: dict = {
        "cookieString": cookie_header(cookies),
        "saved_at": now_iso(),
        "verified": verified,
    }
    if token:
        payload["token"] = token
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    return os.path.abspath(path)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def account_summary(data: dict) -> dict:
    keep = ("id", "user_id", "nickname", "nick_name", "name", "email", "phone", "plan")
    return {k: data[k] for k in keep if data.get(k)}


TOKEN_KEYS = ("token", "access_token", "accessToken", "id_token", "jwt")


def find_token(obj, depth: int = 0):
    """Dig an access token out of an auth response (shape varies by route)."""
    if depth > 4:
        return None
    if isinstance(obj, dict):
        for key in TOKEN_KEYS:
            value = obj.get(key)
            if isinstance(value, str) and value:
                return value
        for value in obj.values():
            found = find_token(value, depth + 1)
            if found:
                return found
    elif isinstance(obj, list):
        for value in obj:
            found = find_token(value, depth + 1)
            if found:
                return found
    return None


def parse_envelope(status: int, text: str):
    """Unwrap the `{success, request_id, data}` envelope.

    Returns (data, None) on success or (None, reason) on failure.
    """
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        snippet = text.strip().replace("\n", " ")[:160]
        return None, f"non-JSON response (HTTP {status}): {snippet}"

    if isinstance(parsed, dict) and parsed.get("success") is False:
        inner = parsed.get("data") or {}
        if isinstance(inner, dict):
            code = inner.get("code") or inner.get("msg") or inner.get("message") or "RequestFailed"
            details = inner.get("details")
            return None, f"{code}{': ' + str(details) if details else ''}"
        return None, f"request failed: {inner}"
    if status >= 400:
        return None, f"HTTP {status}"

    data = parsed.get("data", parsed) if isinstance(parsed, dict) else parsed
    return data, None


# --------------------------------------------------------------------------- #
# commands
# --------------------------------------------------------------------------- #

def read_import_value(value: str) -> str:
    """Accept a file path, "-" for stdin, or the raw payload itself."""
    if value == "-":
        return sys.stdin.read().strip()
    if os.path.isfile(value):
        with open(value, encoding="utf-8") as fh:
            return fh.read().strip()
    return value.strip()


def finish_session(
    cookies: dict[str, str],
    token: str | None,
    out: str,
    do_verify: bool = True,
    force: bool = False,
) -> str:
    """Verify a freshly acquired session and persist it (shared by all flows)."""
    verified: dict | None = None
    if do_verify:
        data, err = verify(cookies, token)
        if err and not force:
            raise SessionError(f"verification failed: {err} (use --force to save anyway)")
        if err:
            print(f"warning: verification failed: {err} — saving unverified", file=sys.stderr)
        else:
            verified = {"at": now_iso(), **account_summary(data)}

    path = save(out, cookies, token, verified)
    status = "verified, ready for login" if verified else "saved (unverified)"
    print(f"Saved {len(cookies)} cookie(s) -> {path}  [{status}]")
    print(f"  names: {', '.join(sorted(cookies)) or '(none — token only)'}")
    if verified:
        print(f"  account: {verified.get('nickname') or verified.get('name') or verified.get('id')}")
    print(f"  next: python {os.path.basename(__file__)} status")
    return path


def cmd_import(args) -> int:
    raw = read_import_value(args.value)
    if not raw:
        raise SessionError('nothing to import — usage: auth-import "<cookies or session.json>"')

    cookies: dict[str, str] = {}
    token: str | None = None

    if raw.startswith("{"):
        try:
            blob = json.loads(raw)
        except json.JSONDecodeError:
            blob = None
        if isinstance(blob, dict) and (
            blob.get("cookies") or blob.get("cookieString") or blob.get("token")
        ):
            cookies.update(blob.get("cookies") or {})
            if blob.get("cookieString"):
                cookies.update(parse_cookie_string(blob["cookieString"]))
            token = blob.get("token") or blob.get("accessToken") or None
        else:
            raise SessionError("JSON payload has none of: cookies / cookieString / token")
    else:
        cookies = parse_cookie_string(raw)

    if args.token:
        token = args.token
    if not cookies:
        raise SessionError("no cookies parsed from the input")

    finish_session(cookies, token, args.out, do_verify=not args.no_verify, force=args.force)
    return 0


def api_post(url: str, body: dict, cookies: dict[str, str], token: str | None = None):
    """POST a JSON body to an auth endpoint; raises SessionError on
    WAF/TMD challenge (no bypass implemented), returns (status, text)."""
    try:
        return http(cookies, token, url, method="POST", body=body)
    except AntiBotChallenge as e:
        raise SessionError(
            f"{url.rsplit('/', 1)[-1]} blocked by anti-bot challenge: {e} — "
            "run the flow once in a browser, then use `auth-import`"
        ) from e


def acquire_session(url: str, body: dict) -> tuple[dict[str, str], str | None, dict]:
    """POST credentials/OTP, absorb Set-Cookie, dig out the token.

    Returns (cookies, token, account_data).
    """
    cookies: dict[str, str] = {}
    status, text = api_post(url, body, cookies)
    data, err = parse_envelope(status, text)
    if err:
        raise SessionError(f"request to {url.rsplit('/', 1)[-1]} failed: {err}")
    return cookies, find_token(data), data if isinstance(data, dict) else {}


def cmd_signin(args) -> int:
    email = args.email or input("email: ").strip()
    password = args.password or getpass.getpass("password: ")
    if not email or not password:
        raise SessionError("email and password are required")

    cookies, token, data = acquire_session(
        SIGNIN_URL, {"email": email, "password": password}
    )
    if not cookies and not token:
        raise SessionError("signin returned neither cookies nor a token")
    finish_session(cookies, token, args.out, do_verify=not args.no_verify, force=args.force)
    return 0


def cmd_signup(args) -> int:
    email = args.email or input("email: ").strip()
    password = args.password or getpass.getpass("password: ")
    if not email or not password:
        raise SessionError("email and password are required")

    body: dict = {"email": email, "password": password}
    if args.name:
        body["name"] = args.name

    cookies, token, data = acquire_session(SIGNUP_URL, body)
    profile = account_summary(data) if data else {}
    print(f"Account requested for {email}  {profile or ''}".rstrip())

    # Some flows open a session immediately; others require email activation
    # first. Save when the response actually authenticated us.
    if cookies or token:
        try:
            finish_session(
                cookies, token, args.out, do_verify=not args.no_verify, force=args.force
            )
            return 0
        except SessionError as e:
            print(f"note: no live session yet ({e})", file=sys.stderr)
    print(
        "next: confirm the activation email, then run "
        f"`python {os.path.basename(__file__)} signin --email {email}` "
        "or the otp-* commands",
        file=sys.stderr,
    )
    return 0


def cmd_otp_request(args) -> int:
    cookies: dict[str, str] = {}
    status, text = api_post(OTP_REQUEST_URL, {"email": args.email}, cookies)
    data, err = parse_envelope(status, text)
    if err:
        raise SessionError(f"otp request failed: {err}")
    hint = f"  ({data})" if isinstance(data, dict) and data else ""
    print(f"One-time code sent to {args.email}{hint}")
    print(f"next: python {os.path.basename(__file__)} otp-verify --email {args.email} --code <CODE>")
    return 0


def cmd_otp_verify(args) -> int:
    cookies, token, _ = acquire_session(
        OTP_VERIFY_URL, {"email": args.email, "otp": args.code}
    )
    if not cookies and not token:
        raise SessionError("otp verify returned neither cookies nor a token")
    finish_session(cookies, token, args.out, do_verify=not args.no_verify, force=args.force)
    return 0


def cmd_status(args) -> int:
    cookies, token, meta = load(args.file)
    data, err = verify(cookies, token)
    report = {
        "file": os.path.abspath(args.file),
        "authenticated": data is not None,
        "saved_at": (meta or {}).get("saved_at"),
        "verified": (meta or {}).get("verified"),
        "cookie_names": sorted(cookies),
        "access_token": bool(token),
    }
    if data:
        report.update(account_summary(data))
    else:
        report["reason"] = err
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if data else 1


def cmd_export(args) -> int:
    cookies, token, _ = load(args.file)
    print(f"Cookie: {cookie_header(cookies)}")
    if token:
        print(f"Authorization: Bearer {token}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="qwen_session",
        description=(
            "Generate a signed-in chat.qwen.ai session via the API "
            "(signup/signin/OTP) and save it to j49_c.txt, ready for login."
        ),
    )
    sub = p.add_subparsers(dest="command", required=True)

    imp = sub.add_parser(
        "auth-import",
        help="import cookies (string, file, or session JSON), verify, save",
    )
    imp.add_argument("value", help='cookie string, file path, session JSON, or "-" for stdin')
    imp.add_argument("--token", help="access token from localStorage (overrides input)")
    imp.add_argument("--out", default=DEFAULT_FILE, help=f"output file (default: {DEFAULT_FILE})")
    imp.add_argument("--no-verify", action="store_true", help="skip the live auth check")
    imp.add_argument("--force", action="store_true", help="save even if verification fails")
    imp.set_defaults(func=cmd_import)

    def add_session_opts(sp, out=True):
        if out:
            sp.add_argument("--out", default=DEFAULT_FILE, help=f"session file (default: {DEFAULT_FILE})")
        sp.add_argument("--no-verify", action="store_true", help="skip the live auth check")
        sp.add_argument("--force", action="store_true", help="save even if verification fails")

    si = sub.add_parser("signin", help="exchange email+password for a session (API)")
    si.add_argument("--email", help="account email (prompted when omitted)")
    si.add_argument("--password", help="password (prompted hidden when omitted)")
    add_session_opts(si)
    si.set_defaults(func=cmd_signin)

    su = sub.add_parser("signup", help="create an account via the API, then save the session")
    su.add_argument("--email", help="account email (prompted when omitted)")
    su.add_argument("--password", help="password (prompted hidden when omitted)")
    su.add_argument("--name", help="display name")
    add_session_opts(su)
    su.set_defaults(func=cmd_signup)

    opr = sub.add_parser("otp-request", help="email a one-time login code")
    opr.add_argument("--email", required=True, help="account email")
    opr.set_defaults(func=cmd_otp_request)

    opv = sub.add_parser("otp-verify", help="exchange an OTP for a session (API)")
    opv.add_argument("--email", required=True, help="account email")
    opv.add_argument("--code", required=True, help="one-time code from the email")
    add_session_opts(opv)
    opv.set_defaults(func=cmd_otp_verify)

    st = sub.add_parser("status", help="check whether the saved session is signed in")
    st.add_argument("--file", default=DEFAULT_FILE, help=f"session file (default: {DEFAULT_FILE})")
    st.set_defaults(func=cmd_status)

    ex = sub.add_parser("export", help="print ready-to-use Cookie / Authorization headers")
    ex.add_argument("--file", default=DEFAULT_FILE, help=f"session file (default: {DEFAULT_FILE})")
    ex.set_defaults(func=cmd_export)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except SessionError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
