"""Offline checks for envelope parsing and token extraction."""
import qwen_session as q

d, e = q.parse_envelope(
    200,
    '{"success": true, "request_id": "r1", "data": {"id": "u1", "token": "T"}}',
)
assert d["id"] == "u1" and e is None, (d, e)
assert q.find_token(d) == "T"
assert q.find_token({"a": {"access_token": "X"}}) == "X"
assert q.find_token({"a": [{"token": "Y"}]}) == "Y"
assert q.find_token({"a": 1}) is None

d, e = q.parse_envelope(
    200, '{"success": false, "data": {"code": "InvalidPassword", "details": "wrong"}}'
)
assert d is None and "InvalidPassword" in e and "wrong" in e, (d, e)

d, e = q.parse_envelope(502, "<html>oops</html>")
assert d is None and "non-JSON" in e, (d, e)

d, e = q.parse_envelope(401, '{"error": "unauthorized"}')
assert d is None and "HTTP 401" in e, (d, e)

# cookie helpers
c = q.parse_cookie_string("a=1; b= 2 ; broken")
assert c == {"a": "1", "b": "2"}, c
q.absorb_set_cookie(c, "a=9; Path=/; HttpOnly")
assert c["a"] == "9"
q.absorb_set_cookie(c, "a=; Max-Age=0; Path=/")
assert "a" not in c

print("unit checks: ok")
