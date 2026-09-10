#!/usr/bin/env bash
# Regression coverage for scripts/ci/validate-admx.py.
#
# Builds a minimal fixture tree (one ADMX, one ADML, one mdm.md) and checks
# each failure mode the validator exists to catch: a $(string.*)/
# $(presentation.*) reference with no matching ADML entry, and a registry
# valueName the mdm.md table does not document, and an ADMX element with no
# matching ADML presentation control. Also checks the real in-repo template
# passes.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VALIDATOR="$REPO_ROOT/scripts/ci/validate-admx.py"
TMP_ROOT="$(mktemp -d -t validate-admx-test.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT

pass=0
fail=0

check() {
  local description="$1"
  local expect_pass="$2"
  shift 2
  if "$@" >/tmp/validate-admx-test.out 2>&1; then
    result=0
  else
    result=1
  fi
  if [[ "$expect_pass" == "pass" && "$result" -eq 0 ]] || [[ "$expect_pass" == "fail" && "$result" -ne 0 ]]; then
    echo "ok - $description"
    pass=$((pass + 1))
  else
    echo "not ok - $description (expected $expect_pass, got exit $result)"
    cat /tmp/validate-admx-test.out
    fail=$((fail + 1))
  fi
}

write_fixture() {
  local dir="$1" missing_ref="$2" undocumented_value="$3"
  mkdir -p "$dir/policy/en-US"
  mkdir -p "$dir/docs/enterprise"

  local ref_name="Widget"
  if [[ "$missing_ref" == "yes" ]]; then
    ref_name="MissingWidget"
  fi

  cat > "$dir/policy/IonEngine.admx" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<policyDefinitions revision="1.0" schemaVersion="1.0">
  <policyNamespaces>
    <target prefix="ionengine" namespace="Ion.Policies.IonEngine" />
  </policyNamespaces>
  <resources minRequiredRevision="1.0" />
  <supportedOn>
    <definitions>
      <definition name="SUPPORTED_IonEngine" displayName="\$(string.SUPPORTED_IonEngine)" />
    </definitions>
  </supportedOn>
  <categories>
    <category name="IonEngine" displayName="\$(string.IonEngine)" />
  </categories>
  <policies>
    <policy name="${ref_name}" class="Machine" displayName="\$(string.${ref_name})" explainText="\$(string.${ref_name}_Explain)" key="SOFTWARE\\Policies\\IonEngine" valueName="${undocumented_value}" presentation="\$(presentation.${ref_name})">
      <parentCategory ref="IonEngine" />
      <supportedOn ref="SUPPORTED_IonEngine" />
      <elements>
        <text id="${ref_name}_Value" valueName="${undocumented_value}" required="true" />
      </elements>
    </policy>
  </policies>
</policyDefinitions>
EOF

  cat > "$dir/policy/en-US/IonEngine.adml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<policyDefinitionResources revision="1.0" schemaVersion="1.0">
  <displayName>Ion Engine</displayName>
  <description>Test fixture.</description>
  <resources>
    <stringTable>
      <string id="SUPPORTED_IonEngine">Ion Engine</string>
      <string id="IonEngine">Ion Engine</string>
      <string id="Widget">Widget</string>
      <string id="Widget_Explain">A widget.</string>
    </stringTable>
    <presentationTable>
      <presentation id="Widget">
        <textBox refId="Widget_Value">
          <label>Widget value:</label>
        </textBox>
      </presentation>
    </presentationTable>
  </resources>
</policyDefinitionResources>
EOF

  cat > "$dir/docs/enterprise/mdm.md" <<'EOF'
| Value name | Type | Example |
|------------|------|---------|
| `Widget` | `REG_SZ` (JSON array) | `["a"]` |
EOF
}

run_against_fixture() {
  local dir="$1"
  python3 -c "
import sys
sys.path.insert(0, '$REPO_ROOT/scripts/ci')
import importlib.util
spec = importlib.util.spec_from_file_location('validate_admx', '$VALIDATOR')
mod = importlib.util.module_from_spec(spec)
from pathlib import Path
spec.loader.exec_module(mod)
mod.ADMX_PATH = Path('$dir/policy/IonEngine.admx')
mod.ADML_PATH = Path('$dir/policy/en-US/IonEngine.adml')
mod.MDM_DOC_PATH = Path('$dir/docs/enterprise/mdm.md')
mod.main()
"
}

# Case 1: valid fixture passes.
write_fixture "$TMP_ROOT/ok" no Widget
check "valid fixture passes" pass run_against_fixture "$TMP_ROOT/ok"

# Case 2: a $(string.*)/$(presentation.*) reference with no ADML entry fails.
write_fixture "$TMP_ROOT/missing-ref" yes Widget
check "missing ADML string/presentation reference fails" fail run_against_fixture "$TMP_ROOT/missing-ref"

# Case 3: a registry valueName absent from mdm.md's table fails.
write_fixture "$TMP_ROOT/undocumented-value" no UndocumentedValue
check "undocumented registry valueName fails" fail run_against_fixture "$TMP_ROOT/undocumented-value"

# Case 4: an ADMX element whose id has no ADML presentation control fails.
write_fixture "$TMP_ROOT/presentation-gap" no Widget
sed -i.bak 's/id="Widget_Value"/id="Widget_Other"/' "$TMP_ROOT/presentation-gap/policy/IonEngine.admx"
check "ADMX element with no presentation control fails" fail run_against_fixture "$TMP_ROOT/presentation-gap"

# Case 5: the real in-repo template passes end to end.
check "real in-repo IonEngine.admx/.adml pass" pass python3 "$VALIDATOR"

echo ""
echo "validate-admx.test.sh: ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]]
