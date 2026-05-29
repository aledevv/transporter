#!/usr/bin/env python3
"""
🔍 Trova duplicati nel database Firestore degli istituti.

Questo script:
1. Scarica tutti i documenti dalla collection 'institutes'
2. Li confronta usando matching fuzzy su nome + indirizzo
3. Stampa i gruppi di possibili duplicati per la tua revisione

NON elimina nulla. Tu decidi cosa fare.

Uso:
    python scripts/find_duplicates.py
"""

import requests
import re
from collections import defaultdict

PROJECT_ID = "bus-plan-6d002"
BASE_URL = f"https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents/institutes"

# ─── Costanti per normalizzazione (stesse di matchInstitutes.js) ───────────

TYPE_PREFIXES = [
    'istituto comprensivo', 'istituto tecnico', 'istituto professionale',
    'istituto', 'comprensivo', 'liceo scientifico', 'liceo classico',
    'liceo artistico', 'liceo', 'scuola secondaria di primo grado',
    'scuola secondaria di secondo grado', 'scuola elementare',
    'scuola media', 'scuola primaria', 'scuola', 'centro formazione',
    'centro di formazione professionale', 'cfp',
    'ic ', 'iis ', 'isis ', 'itis ', 'ipss ', 'ites ', 'itc ',
]

NAME_TYPE_STOP = {
    'iis', 'isis', 'itis', 'ipss', 'ites', 'itc', 'cfp',
    'istituto', 'comprensivo', 'tecnico', 'professionale',
    'liceo', 'scientifico', 'classico', 'artistico',
    'scuola', 'secondaria', 'primaria', 'elementare', 'media',
    'centro', 'formazione',
}

ADDR_STOP = {
    'via', 'viale', 'vle', 'piazza', 'pza', 'pzza', 'corso', 'cso',
    'strada', 'vicolo', 'largo', 'borgo', 'contrada', 'localita',
    'localit', 'frazione', 'fraz', 'loc', 'del', 'della', 'dello',
    'dei', 'degli', 'delle', 'di', 'da', 'in', 'le', 'la', 'il',
    'gli', 'con', 'per', 'tra', 'fra',
}


# ─── Funzioni di normalizzazione ──────────────────────────────────────────

def normalize_name(name):
    s = (name or '').lower().strip()
    for p in TYPE_PREFIXES:
        if s.startswith(p):
            s = s[len(p):].strip()
            break
    s = re.sub(r'[^\w\sàèéìòù]', ' ', s)
    tokens = s.split()
    return [t for t in tokens if len(t) >= 3 and t not in NAME_TYPE_STOP]


def normalize_address(addr):
    s = (addr or '').lower()
    s = re.sub(r'[,.\-;:]', ' ', s)
    s = re.sub(r'\b\d+[a-z]?\b', ' ', s)
    tokens = s.split()
    return [t for t in tokens if len(t) >= 3 and t not in ADDR_STOP]


def token_overlap(a, b):
    if not a or not b:
        return 0
    matches = [t for t in a if any(t in u or u in t for u in b)]
    return min(len(matches) / min(len(a), len(b)), 1.0)


def similarity(doc_a, doc_b):
    """Score di somiglianza tra due documenti (0-1)"""
    name_a = normalize_name(doc_a['name'])
    name_b = normalize_name(doc_b['name'])
    name_score = token_overlap(name_a, name_b)

    addr_a = normalize_address(doc_a['address'])
    addr_b = normalize_address(doc_b['address'])
    addr_score = token_overlap(addr_a, addr_b)

    # Global overlap
    all_a = list(set(name_a + addr_a))
    all_b = list(set(name_b + addr_b))
    global_score = 0
    if all_a and all_b:
        intersection = [t for t in all_a if any(t in u or u in t for u in all_b)]
        global_score = len(intersection) / max(len(all_a), len(all_b))

    weighted = name_score * 0.4 + addr_score * 0.6

    # Bonus indirizzo esatto
    bonus = 0
    raw_a = (doc_a['address'] or '').lower().strip()
    raw_b = (doc_b['address'] or '').lower().strip()
    if raw_a and raw_b:
        if raw_a == raw_b:
            bonus = 0.15
        elif raw_a in raw_b or raw_b in raw_a:
            bonus = 0.08

    return max(weighted, global_score) + bonus


# ─── Fetch da Firestore ──────────────────────────────────────────────────

def get_all_docs():
    docs = []
    page_token = None
    while True:
        params = {"pageSize": 300}
        if page_token:
            params["pageToken"] = page_token
        res = requests.get(BASE_URL, params=params)
        res.raise_for_status()
        data = res.json()
        if "documents" in data:
            docs.extend(data["documents"])
        if "nextPageToken" in data:
            page_token = data["nextPageToken"]
        else:
            break
    return docs


def parse_doc(raw):
    fields = raw.get("fields", {})
    return {
        'doc_id': raw["name"].split("/")[-1],
        'full_path': raw["name"],
        'name': fields.get("name", {}).get("stringValue", ""),
        'address': fields.get("address", {}).get("stringValue", ""),
        'lat': fields.get("lat", {}).get("doubleValue", None),
        'lon': fields.get("lon", {}).get("doubleValue", None),
        'description': fields.get("description", {}).get("stringValue", ""),
    }


# ─── Union-Find per raggruppare duplicati ────────────────────────────────

class UnionFind:
    def __init__(self, n):
        self.parent = list(range(n))
        self.rank = [0] * n

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, x, y):
        rx, ry = self.find(x), self.find(y)
        if rx == ry:
            return
        if self.rank[rx] < self.rank[ry]:
            rx, ry = ry, rx
        self.parent[ry] = rx
        if self.rank[rx] == self.rank[ry]:
            self.rank[rx] += 1


# ─── Funzioni di evidenziazione ed estrazione somiglianze ──────────────────

def highlight_similarities(text, other_texts, color_match="\033[1;32m", color_diff="\033[2m"):
    """
    Evidenzia i token di testo comuni in verde (o altro colore)
    e attenua (o lascia normali) le parti differenti.
    """
    if not text:
        return ""
    # Dividiamo il testo mantenendo la punteggiatura e gli spazi
    tokens = re.split(r'(\W+)', text)
    
    other_words_sets = []
    for ot in other_texts:
        if ot:
            # Estrae parole di almeno 2 caratteri alfanumerici
            words = set(re.findall(r'\b\w{2,}\b', ot.lower()))
            other_words_sets.append(words)
            
    result = []
    for token in tokens:
        # Se è una parola di almeno 2 lettere
        if re.match(r'^\w{2,}$', token):
            token_lower = token.lower()
            # Controlla se è condivisa con ALMENO uno degli altri testi del gruppo
            is_shared = any(token_lower in s for s in other_words_sets)
            if is_shared:
                result.append(f"{color_match}{token}\033[0m")
            else:
                result.append(f"{color_diff}{token}\033[0m")
        else:
            # Gestione della punteggiatura e spazi (attenuati se color_diff è dim)
            if color_diff == "\033[2m":
                result.append(f"\033[2m{token}\033[0m")
            else:
                result.append(token)
                
    return "".join(result)


def check_coords_group(group):
    """
    Analizza e colora lo stato delle coordinate del gruppo.
    """
    lats = [d.get('lat') for d in group if d.get('lat') is not None]
    lons = [d.get('lon') for d in group if d.get('lon') is not None]
    
    if len(lats) < len(group) or len(lons) < len(group):
        return "\033[33m⚠️ Coordinate parziali/assenti\033[0m"
        
    # Coordinate identiche
    if len(set(lats)) == 1 and len(set(lons)) == 1:
        return f"\033[1;32m🟢 IDENTICHE ({lats[0]}, {lons[0]})\033[0m"
        
    # Calcoliamo la distanza massima tra le coppie del gruppo
    max_dist = 0
    for i in range(len(group)):
        for j in range(i + 1, len(group)):
            lat1, lon1 = group[i]['lat'], group[i]['lon']
            lat2, lon2 = group[j]['lat'], group[j]['lon']
            # Distanza approssimativa in metri
            dist = ((lat1 - lat2)**2 + (lon1 - lon2)**2)**0.5 * 111000
            if dist > max_dist:
                max_dist = dist
                
    if max_dist < 15:
        return f"\033[1;32m🟢 QUASI IDENTICHE (distanza max ~{max_dist:.1f}m)\033[0m"
    elif max_dist < 150:
        return f"\033[33m🟡 VICINE (distanza max ~{max_dist:.1f}m)\033[0m"
    else:
        return f"\033[31m🔴 DIVERSE (distanza max ~{max_dist:.1f}m)\033[0m"


def get_common_elements_summary(group):
    """
    Trova e restituisce una stringa con le parole del nome e indirizzo comuni a TUTTI gli elementi.
    """
    common_names = None
    common_addrs = None
    
    for d in group:
        # Parole normalizzate del nome
        name_words = set(re.findall(r'\b\w{2,}\b', (d.get('name') or '').lower()))
        if common_names is None:
            common_names = name_words
        else:
            common_names = common_names.intersection(name_words)
            
        # Parole normalizzate dell'indirizzo
        addr_words = set(re.findall(r'\b\w{2,}\b', (d.get('address') or '').lower()))
        if common_addrs is None:
            common_addrs = addr_words
        else:
            common_addrs = common_addrs.intersection(addr_words)
            
    # Filtriamo stop words comuni e parole corte
    stopwords = {
        'via', 'viale', 'piazza', 'corso', 'vicolo', 'largo', 'di', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra', 
        'ic', 'iis', 'istituto', 'comprensivo', 'scuola', 'italia', 'trento', 'trentino', 'alto', 'adige', 
        'provincia', 'südtirol', 'comunità', 'val', 'valle', 'territorio', 'della', 'dello', 'delle', 'degli', 
        'del', 'al', 'ai', 'allo', 'alla', 'alle', 'dal', 'dallo', 'dalla', 'dalle', 'nel', 'nello', 'nella', 
        'negli', 'nelle', 'un', 'una', 'uno', 'il', 'lo', 'la', 'i', 'gli', 'le', 'don', 'g', 'sede', 'plesso',
        'frazione', 'loc', 'località'
    }
    
    clean_names = [w for w in (common_names or []) if w not in stopwords]
    clean_addrs = [w for w in (common_addrs or []) if w not in stopwords]
    
    summary_parts = []
    if clean_names:
        summary_parts.append(f"Nome simile su: \033[1;32m{', '.join(clean_names)}\033[0m")
    if clean_addrs:
        summary_parts.append(f"Indirizzo simile su: \033[1;36m{', '.join(clean_addrs)}\033[0m")
        
    return " | ".join(summary_parts) if summary_parts else "Nessuna parola comune significativa"


# ─── Main ────────────────────────────────────────────────────────────────

THRESHOLD = 0.70  # Soglia di somiglianza per considerare un possibile duplicato

if __name__ == "__main__":
    print("📡 Scaricamento documenti da Firestore...")
    raw_docs = get_all_docs()
    docs = [parse_doc(d) for d in raw_docs]
    print(f"📦 Trovati {len(docs)} documenti totali\n")

    # 1. Duplicati esatti (stesso indirizzo lowercase)
    addr_groups = defaultdict(list)
    for d in docs:
        key = (d['address'] or '').strip().lower()
        if key:
            addr_groups[key].append(d)

    exact_dupes = {k: v for k, v in addr_groups.items() if len(v) > 1}

    # 2. Duplicati fuzzy (confronto N^2 con Union-Find)
    n = len(docs)
    uf = UnionFind(n)

    print("🔍 Confronto fuzzy in corso...")
    comparisons = 0
    for i in range(n):
        for j in range(i + 1, n):
            score = similarity(docs[i], docs[j])
            if score >= THRESHOLD:
                uf.union(i, j)
            comparisons += 1
            if comparisons % 10000 == 0:
                print(f"   ... {comparisons}/{n*(n-1)//2} confronti")

    # Raggruppa per cluster
    clusters = defaultdict(list)
    for i in range(n):
        root = uf.find(i)
        clusters[root].append(i)

    dup_clusters = {k: v for k, v in clusters.items() if len(v) > 1}

    # 3. Duplicati per coordinate geografiche vicine E indirizzo simile (distanza < 30m e overlap indirizzo >= 50%)
    uf_coords = UnionFind(n)
    for i in range(n):
        for j in range(i + 1, n):
            lat1, lon1 = docs[i]['lat'], docs[i]['lon']
            lat2, lon2 = docs[j]['lat'], docs[j]['lon']
            if lat1 is not None and lon1 is not None and lat2 is not None and lon2 is not None:
                # Distanza approssimativa in metri
                dist = ((lat1 - lat2)**2 + (lon1 - lon2)**2)**0.5 * 111000
                if dist < 30:
                    addr_a = normalize_address(docs[i]['address'])
                    addr_b = normalize_address(docs[j]['address'])
                    addr_score = token_overlap(addr_a, addr_b)
                    if addr_score >= 0.5:
                        uf_coords.union(i, j)

    coord_clusters = defaultdict(list)
    for i in range(n):
        if docs[i]['lat'] is not None and docs[i]['lon'] is not None:
            root = uf_coords.find(i)
            coord_clusters[root].append(i)

    geo_dupes = {k: v for k, v in coord_clusters.items() if len(v) > 1}

    # ─── Output ──────────────────────────────────────────────────────────

    print("\n" + "=" * 80)
    print("📋 DUPLICATI ESATTI (stesso indirizzo)")
    print("=" * 80)

    if not exact_dupes:
        print("✅ Nessun duplicato esatto trovato!")
    else:
        for i, (addr, group) in enumerate(exact_dupes.items(), 1):
            print(f"\n🔴 Gruppo {i} — Indirizzo identico: \"\033[1;36m{addr}\033[0m\"")
            coord_status = check_coords_group(group)
            print(f"   \033[1mCoordinate:\033[0m {coord_status}")
            for d in group:
                other_docs = [x for x in group if x != d]
                other_names = [x['name'] for x in other_docs]
                highlighted_name = highlight_similarities(d['name'], other_names, color_match="\033[1;32m", color_diff="\033[2m")
                
                desc_str = f" | \033[2mDesc:\033[0m {d['description']}" if d['description'] else ""
                print(f"   • \033[1;30m[{d['doc_id'][:15]}...]\033[0m {highlighted_name}{desc_str}")

    print("\n" + "=" * 80)
    print("🔍 DUPLICATI FUZZY (nomi/indirizzi simili)")
    print("=" * 80)

    if not dup_clusters:
        print("✅ Nessun duplicato fuzzy trovato!")
    else:
        shown = 0
        for cluster_id, indices in sorted(dup_clusters.items(), key=lambda x: -len(x[1])):
            shown += 1
            group = [docs[i] for i in indices]
            # Calcola lo score tra il primo e gli altri per mostrarlo
            scores = []
            for i in range(1, len(group)):
                s = similarity(group[0], group[i])
                scores.append(f"{s:.0%}")

            coord_status = check_coords_group(group)
            common_info = get_common_elements_summary(group)

            print(f"\n🟡 Gruppo {shown} ({len(group)} documenti, sim: {', '.join(scores)})")
            print(f"   \033[1mSomiglianze:\033[0m {common_info}")
            print(f"   \033[1mCoordinate:\033[0m  {coord_status}")
            
            for d in group:
                other_docs = [x for x in group if x != d]
                other_names = [x['name'] for x in other_docs]
                other_addrs = [x['address'] for x in other_docs]
                
                highlighted_name = highlight_similarities(d['name'], other_names, color_match="\033[1;32m", color_diff="\033[2m")
                highlighted_addr = highlight_similarities(d['address'], other_addrs, color_match="\033[1;36m", color_diff="\033[2m")
                
                desc_str = ""
                if d['description']:
                    other_descs = [x['description'] for x in other_docs if x['description']]
                    highlighted_desc = highlight_similarities(d['description'], other_descs, color_match="\033[1;33m", color_diff="\033[2m")
                    desc_str = f"\n     \033[2mDesc:\033[0m {highlighted_desc}"

                print(f"   • \033[1;30m[{d['doc_id'][:15]}...]\033[0m {highlighted_name}")
                print(f"     \033[2mIndirizzo:\033[0m {highlighted_addr}{desc_str}")
                print(f"     \033[2mCoord:\033[0m     {d['lat']}, {d['lon']}")

    print("\n" + "=" * 80)
    print("📍 CO-UBICATI CON INDIRIZZO SIMILE (Distanza < 30m e Indirizzo Simile)")
    print("=" * 80)

    if not geo_dupes:
        print("✅ Nessun duplicato co-ubicato con indirizzo simile trovato!")
    else:
        shown_geo = 0
        for cluster_id, indices in sorted(geo_dupes.items(), key=lambda x: -len(x[1])):
            shown_geo += 1
            group = [docs[i] for i in indices]
            
            coord_status = check_coords_group(group)
            common_info = get_common_elements_summary(group)

            print(f"\n📍 Gruppo {shown_geo} ({len(group)} documenti co-ubicati)")
            print(f"   \033[1mSomiglianze:\033[0m {common_info}")
            print(f"   \033[1mCoordinate:\033[0m  {coord_status}")
            
            for d in group:
                other_docs = [x for x in group if x != d]
                other_names = [x['name'] for x in other_docs]
                other_addrs = [x['address'] for x in other_docs]
                
                highlighted_name = highlight_similarities(d['name'], other_names, color_match="\033[1;32m", color_diff="\033[2m")
                highlighted_addr = highlight_similarities(d['address'], other_addrs, color_match="\033[1;36m", color_diff="\033[2m")
                
                desc_str = ""
                if d['description']:
                    other_descs = [x['description'] for x in other_docs if x['description']]
                    highlighted_desc = highlight_similarities(d['description'], other_descs, color_match="\033[1;33m", color_diff="\033[2m")
                    desc_str = f"\n     \033[2mDesc:\033[0m {highlighted_desc}"

                print(f"   • \033[1;30m[{d['doc_id'][:15]}...]\033[0m {highlighted_name}")
                print(f"     \033[2mIndirizzo:\033[0m {highlighted_addr}{desc_str}")
                print(f"     \033[2mCoord:\033[0m     {d['lat']}, {d['lon']}")

    # ─── Riepilogo ───────────────────────────────────────────────────────

    print("\n" + "=" * 80)
    print("📊 RIEPILOGO")
    print("=" * 80)
    print(f"   Documenti totali:                       {len(docs)}")
    print(f"   Gruppi duplicati esatti:                 {len(exact_dupes)}")
    print(f"   Gruppi duplicati fuzzy:                  {len(dup_clusters)}")
    print(f"   Gruppi co-ubicati con indirizzo simile:  {len(geo_dupes)}")
    total_dup_docs = sum(len(v) - 1 for v in dup_clusters.values())
    print(f"   Documenti potenzialmente rimovibili:     {total_dup_docs}")
    print()
    print("⚠️  Questo script NON elimina nulla. Controlla i gruppi sopra e decidi tu!")
    print(f"   Per eliminare, usa: python scripts/remove_duplicates.py")
