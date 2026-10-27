"""
Merge Firestore `institutes` entries that are the same point under different names.

The kept entry gets the dropped entries' names (and their aliases) in `aliases`,
then the dropped entries are deleted. Dry run by default; --apply writes.
A JSON backup of every touched document is written before any change.

    python tools/merge_institutes.py --keep KEEP_ID --drop ID1 ID2
    python tools/merge_institutes.py --keep KEEP_ID --drop ID1 ID2 --apply

Needs google-cloud-firestore and Application Default Credentials
(gcloud auth application-default login).
"""
import argparse
import datetime
import json
import os
import sys
import unicodedata

DEFAULT_PROJECT = 'bus-plan-6d002'


def normalize_for_compare(text):
    """Case- and accent-insensitive form, same rule as the frontend matcher."""
    text = unicodedata.normalize('NFD', text or '')
    text = ''.join(c for c in text if not unicodedata.combining(c)).lower()
    return ' '.join(''.join(c if c.isalnum() else ' ' for c in text).split())


def build_merge(keep, drops):
    """
    keep / drops: document dicts with at least `name`, optional `originalName`
    and `aliases`. Returns the new `aliases` list for the kept document:
    its own aliases followed by the dropped names and aliases, without
    duplicates and without the kept entry's own name.
    """
    seen = {normalize_for_compare(keep.get('name')), normalize_for_compare(keep.get('originalName'))}
    seen.discard('')
    aliases = []
    candidates = list(keep.get('aliases') or [])
    for d in drops:
        candidates += [d.get('name'), d.get('originalName')] + list(d.get('aliases') or [])
    for alias in candidates:
        alias = (alias or '').strip()
        key = normalize_for_compare(alias)
        if not key or key in seen:
            continue
        seen.add(key)
        aliases.append(alias)
    return aliases


def _serializable(doc):
    return {k: (v.isoformat() if hasattr(v, 'isoformat') else v) for k, v in doc.items()}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--keep', required=True, help='id of the document to keep')
    parser.add_argument('--drop', required=True, nargs='+', help='ids of the documents to merge into it')
    parser.add_argument('--project', default=DEFAULT_PROJECT)
    parser.add_argument('--backup-dir', default='.')
    parser.add_argument('--apply', action='store_true', help='write to Firestore (default: dry run)')
    args = parser.parse_args(argv)

    if args.keep in args.drop:
        sys.exit('--keep cannot also be in --drop')

    from google.cloud import firestore  # imported here so tests don't need it

    client = firestore.Client(project=args.project)
    col = client.collection('institutes')
    snaps = {i: col.document(i).get() for i in [args.keep, *args.drop]}
    missing = [i for i, s in snaps.items() if not s.exists]
    if missing:
        sys.exit(f'Documents not found: {", ".join(missing)}')

    docs = {i: s.to_dict() for i, s in snaps.items()}
    keep = docs[args.keep]
    drops = [docs[i] for i in args.drop]
    aliases = build_merge(keep, drops)

    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    backup = os.path.join(args.backup_dir, f'institutes-merge-backup-{stamp}.json')
    with open(backup, 'w', encoding='utf-8') as f:
        json.dump({i: _serializable(d) for i, d in docs.items()}, f, ensure_ascii=False, indent=2)

    print(f'Keep  {args.keep}: {keep.get("name")} | {keep.get("address")}')
    for i in args.drop:
        print(f'Drop  {i}: {docs[i].get("name")} | {docs[i].get("address")}')
    print(f'Aliases after merge: {aliases}')
    print(f'Backup: {backup}')

    if not args.apply:
        print('Dry run: nothing written. Add --apply to merge.')
        return

    batch = client.batch()
    batch.update(col.document(args.keep), {'aliases': aliases})
    for i in args.drop:
        batch.delete(col.document(i))
    batch.commit()
    print('Merged.')


if __name__ == '__main__':
    main()
