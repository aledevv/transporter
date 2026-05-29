import requests

project_id = "bus-plan-6d002"
base_url = f"https://firestore.googleapis.com/v1/projects/{project_id}/databases/(default)/documents/institutes"

def get_all():
    docs = []
    page_token = None
    while True:
        url = base_url
        params = {"pageSize": 300}
        if page_token:
            params["pageToken"] = page_token
        res = requests.get(url, params=params)
        res.raise_for_status()
        data = res.json()
        if "documents" in data:
            docs.extend(data["documents"])
        if "nextPageToken" in data:
            page_token = data["nextPageToken"]
        else:
            break
    return docs

def delete_doc(name):
    url = f"https://firestore.googleapis.com/v1/{name}"
    res = requests.delete(url)
    res.raise_for_status()

if __name__ == "__main__":
    docs = get_all()
    print(f"Total documents found: {len(docs)}")

    seen_addresses = {}
    duplicates = []

    for doc in docs:
        fields = doc.get("fields", {})
        addr_field = fields.get("address", {})
        address = addr_field.get("stringValue", "").strip().lower()
        
        # We only consider non-empty addresses for duplication
        if not address:
            continue
            
        doc_name = doc["name"]
        
        if address in seen_addresses:
            duplicates.append(doc_name)
        else:
            seen_addresses[address] = doc_name

    print(f"Found {len(duplicates)} duplicate documents based on exact address string.")

    for i, doc_name in enumerate(duplicates):
        delete_doc(doc_name)
        if (i + 1) % 10 == 0:
            print(f"Deleted {i + 1}/{len(duplicates)}...")

    print(f"Successfully deleted {len(duplicates)} duplicates. Kept {len(seen_addresses)} unique addresses.")
