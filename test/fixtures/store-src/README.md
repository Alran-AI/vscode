# Test store

Source of `test/fixtures/store/`, the small offline store the tests use (two Plugins, three Skills,
one Plugin with a hook so the approval step can be tested). Build it with the store builder of the
Alran CLI and copy the result:

```bash
node ../alran-code/tools/store/build-store.mjs --source test/fixtures/store-src
cp -r test/fixtures/store-src/store/{index.json,archives,icons} test/fixtures/store/
rm -r test/fixtures/store-src/store/{index.json,archives}
```

A Skill's `description` must be valid YAML: a `: ` inside it hides the whole Plugin from the Runtime
without any message, even though the validator and the installer accept it.
