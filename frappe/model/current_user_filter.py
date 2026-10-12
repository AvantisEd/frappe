# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and Contributors
# License: MIT. See LICENSE

"""`@me` in a filter value: whoever is signed in when the query runs.

A saved layout, a sidebar link or a URL carries its filter values literally, so
"assigned to me" saved by one user means that user for everyone who opens it.
`@me` is resolved per request instead, which lets a single shared "My Tasks"
work for each viewer.

Only fields that hold user ids are resolved - Assigned To, Liked By, Created By,
Modified By and Link fields to User - so "@me" typed into any other field still
means the literal text. A value matches the token only whole: "@me" for `=`,
`!=`, `in` lists and the like, and "%@me%" for the `like` filter the list view
builds for Assigned To. A real user id containing "@me" (someone@me.com) is
never touched.
"""

import frappe

CURRENT_USER = "@me"

# Standard columns that store user ids (_assign and _liked_by as a JSON list)
_USER_COLUMNS = frozenset(("owner", "modified_by", "_assign", "_liked_by"))
_LIKE_TOKEN = f"%{CURRENT_USER}%"


def resolve_current_user(doctype: str | None, fieldname, value):
	"""Return `value` with the `@me` token replaced by the session user, for user-id fields."""

	if not _has_token(value) or not isinstance(fieldname, str):
		return value
	if not is_user_field(doctype, fieldname):
		return value

	user = frappe.session.user
	if isinstance(value, str):
		return _substitute(value, user)
	return type(value)(_substitute(item, user) for item in value)


def is_user_field(doctype: str | None, fieldname: str) -> bool:
	if fieldname in _USER_COLUMNS:
		return True
	if not doctype:
		return False
	df = frappe.get_meta(doctype).get_field(fieldname)
	return bool(df and df.fieldtype == "Link" and df.options == "User")


def _has_token(value) -> bool:
	if isinstance(value, str):
		return value in (CURRENT_USER, _LIKE_TOKEN)
	if isinstance(value, list | tuple | set):
		return any(isinstance(item, str) and item in (CURRENT_USER, _LIKE_TOKEN) for item in value)
	return False


def _substitute(value, user: str):
	if value == CURRENT_USER:
		return user
	if value == _LIKE_TOKEN:
		return f"%{user}%"
	return value
