---
"@navapi/core": minor
"@navapi/cli": minor
---

Add `navapi profile export` and `navapi profile import` (#1).

Exports carry profiles and the credentials they reference as portable JSON and
**never contain a secret**, so the file is safe to commit or hand to a
colleague. Exporting a subset exports only the credentials those profiles use,
and a pinned Azure CLI identity is deliberately left out — it names one
person's login and would be wrong on anyone else's machine.

Importing refuses name collisions and lists all of them at once rather than
failing one at a time (`--overwrite` replaces, `--rename old=new` keeps both),
then reports which credentials still need a secret. A file that carries a
secret is rejected outright rather than quietly cleaned: navapi never writes
one, so its presence means the secret was mishandled and should be treated as
compromised.
