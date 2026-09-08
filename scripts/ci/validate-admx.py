#!/usr/bin/env python3
"""validate-admx.py — cross-checks the Ion Engine Group Policy ADMX/ADML pair.

Two independent failure modes an XML-well-formedness check alone would miss:

1. Every $(string.X) / $(presentation.X) reference in IonEngine.admx must
   resolve to a <string id="X"> / <presentation id="X"> entry in the en-US
   ADML. gpedit.msc silently drops (or refuses to render) a policy whose
   reference is missing — there is no build-time XML validator for this,
   which is exactly why a script owns it.
2. Every policy's registry valueName -- on the <policy> itself or on any
   element inside it -- must be documented in docs/enterprise/mdm.md's
   Windows registry table, so the template never drifts from the engine's
   actual enterprise-config reader.
3. Every element id in the ADMX must have a matching presentation control
   refId in the ADML, and vice versa. gpedit refuses to render a policy whose
   presentation does not cover its elements.

Exit 0 and print each check on success; exit 1 with the specific mismatch
otherwise.
"""
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ADMX_PATH = ROOT / "packaging" / "windows" / "policy" / "IonEngine.admx"
ADML_PATH = ROOT / "packaging" / "windows" / "policy" / "en-US" / "IonEngine.adml"
MDM_DOC_PATH = ROOT / "docs" / "enterprise" / "mdm.md"


def fail(message: str) -> None:
    print(f"validate-admx: FAIL: {message}", file=sys.stderr)
    sys.exit(1)


def find_refs(root: ET.Element) -> tuple[set[str], set[str]]:
    string_refs: set[str] = set()
    presentation_refs: set[str] = set()
    for elem in root.iter():
        for attr_value in elem.attrib.values():
            for m in re.finditer(r"\$\(string\.([A-Za-z0-9_]+)\)", attr_value):
                string_refs.add(m.group(1))
            for m in re.finditer(r"\$\(presentation\.([A-Za-z0-9_]+)\)", attr_value):
                presentation_refs.add(m.group(1))
    return string_refs, presentation_refs


def registry_value_names(admx_root: ET.Element) -> set[str]:
    """Every valueName the template writes: on the <policy> itself (the
    on/off value) and on each element inside <elements> (text, multiText,
    decimal, boolean, enum)."""
    names: set[str] = set()
    for policy in admx_root.iter("policy"):
        for node in [policy, *policy.iter()]:
            value_name = node.get("valueName")
            if value_name:
                names.add(value_name)
    return names


def element_ids(admx_root: ET.Element) -> set[str]:
    """ids of every element inside a policy's <elements> block."""
    ids: set[str] = set()
    for elements in admx_root.iter("elements"):
        for node in elements:
            node_id = node.get("id")
            if node_id:
                ids.add(node_id)
    return ids


def presentation_ref_ids(adml_root: ET.Element) -> set[str]:
    """refIds of every control in the ADML presentation table."""
    refs: set[str] = set()
    for presentation in adml_root.iter("presentation"):
        for node in presentation.iter():
            ref = node.get("refId")
            if ref:
                refs.add(ref)
    return refs


def documented_value_names(mdm_doc_text: str) -> set[str]:
    # Rows look like: | `AllowedModels` | `REG_MULTI_SZ` | one per line |
    return set(
        re.findall(r"^\|\s*`([A-Za-z]+)`\s*\|\s*`REG_[A-Z_]+`", mdm_doc_text, re.MULTILINE)
    )


def main() -> None:
    admx_root = ET.parse(ADMX_PATH).getroot()
    adml_root = ET.parse(ADML_PATH).getroot()

    string_refs, presentation_refs = find_refs(admx_root)

    adml_string_ids = {s.get("id") for s in adml_root.iter("string")}
    adml_presentation_ids = {p.get("id") for p in adml_root.iter("presentation")}

    missing_strings = string_refs - adml_string_ids
    if missing_strings:
        fail(f"ADMX references $(string.*) ids missing from ADML: {sorted(missing_strings)}")

    missing_presentations = presentation_refs - adml_presentation_ids
    if missing_presentations:
        fail(f"ADMX references $(presentation.*) ids missing from ADML: {sorted(missing_presentations)}")

    print(f"validate-admx: OK — {len(string_refs)} string refs, {len(presentation_refs)} presentation refs all resolve")

    admx_element_ids = element_ids(admx_root)
    adml_ref_ids = presentation_ref_ids(adml_root)
    unpresented = admx_element_ids - adml_ref_ids
    if unpresented:
        fail(f"ADMX elements with no ADML presentation control: {sorted(unpresented)}")
    orphan_refs = adml_ref_ids - admx_element_ids
    if orphan_refs:
        fail(f"ADML presentation controls with no ADMX element: {sorted(orphan_refs)}")
    print(f"validate-admx: OK — {len(admx_element_ids)} elements each have a presentation control")

    admx_value_names = registry_value_names(admx_root)
    if not admx_value_names:
        fail("ADMX declares no registry value names — the template writes nothing")
    mdm_doc_text = MDM_DOC_PATH.read_text()
    doc_value_names = documented_value_names(mdm_doc_text)

    undocumented = admx_value_names - doc_value_names
    if undocumented:
        fail(
            "ADMX policies reference registry value names not documented in "
            f"docs/enterprise/mdm.md's Windows registry table: {sorted(undocumented)}"
        )

    print(
        f"validate-admx: OK — all {len(admx_value_names)} ADMX registry value names "
        "are documented in docs/enterprise/mdm.md"
    )


if __name__ == "__main__":
    main()
