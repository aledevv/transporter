import os
import re
import copy
from datetime import datetime
from docx import Document
from docx.table import Table
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt

# Administrative parts Nominatim appends that mean nothing on a transport plan
_ADMIN_PARTS = re.compile(
    r'^(Comunit[aà]|Comun General|Magnifica Comunit[aà]|Provincia|Territorio|Trentino|Alto Adige|'
    r'S[üu]dtirol|South Tyrol|Sud Tirol|Italia|Italy|Veneto|Lombardia)\b', re.IGNORECASE)


def _shorten_address(address):
    """Strip the administrative tail of a Nominatim address for display in documents."""
    if not address:
        return address
    parts = [p.strip() for p in address.split(',')]
    kept = [p for p in parts if p and not _ADMIN_PARTS.match(p)
            and not re.fullmatch(r'\d{5}', p) and not re.fullmatch(r'[A-Z]{2}', p)]
    return ', '.join(kept) if kept else address.strip()


def _doc_place(address):
    """Meeting place for the table: short street, never bare coordinates."""
    if re.fullmatch(r'\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*', address or ''):
        return ''
    return _shorten_address(address)


def _doc_time(value, default):
    """Times as the templates write them: '8,30' (no leading zero, comma)."""
    m = re.fullmatch(r'\s*(\d{1,2})[:.,](\d{2})\s*', value or '')
    return f"{int(m.group(1))},{m.group(2)}" if m else (value or default)


def _doc_km(meters):
    """Distance as the documents write it: '132,7 km'."""
    return f"{meters / 1000:.1f}".replace('.', ',') + ' km'


def _replace_text_in_paragraph(paragraph, search_text, replace_text):
    """Safely replace text within a paragraph while trying to preserve formatting."""
    if search_text not in paragraph.text:
        return
        
    for run in paragraph.runs:
        if search_text in run.text:
            run.text = run.text.replace(search_text, replace_text)
            return

    # Fallback if it spans multiple runs (use first run's formatting)
    if paragraph.runs:
        first_run = paragraph.runs[0]
        target_color = first_run.font.color.rgb if (first_run.font and first_run.font.color) else None
        target_size = first_run.font.size if first_run.font else None
        target_bold = first_run.font.bold if first_run.font else None
    else:
        target_color, target_size, target_bold = None, None, None

    new_text = paragraph.text.replace(search_text, replace_text)
    paragraph.clear()
    new_run = paragraph.add_run(new_text)
    if target_color:
        new_run.font.color.rgb = target_color
    if target_size:
        new_run.font.size = target_size
    if target_bold is not None:
        new_run.font.bold = target_bold


def _use_one_font(doc, font):
    """
    The client's template uses one font everywhere: set it on every run (template
    text and generated text), on every style and on the document defaults, for
    all scripts, so nothing falls back to another font.
    """
    def fix(rpr_parent):
        rpr = rpr_parent.find(qn('w:rPr'))
        if rpr is None:
            rpr = OxmlElement('w:rPr')
            if rpr_parent.tag == qn('w:style'):
                # In a style rPr comes after pPr and before the table properties
                after = next((c for c in rpr_parent if c.tag in (qn('w:tblPr'), qn('w:trPr'), qn('w:tcPr'), qn('w:tblStylePr'))), None)
                if after is not None:
                    after.addprevious(rpr)
                else:
                    rpr_parent.append(rpr)
            else:
                rpr_parent.insert(0, rpr)
        fonts = rpr.find(qn('w:rFonts'))
        if fonts is None:
            fonts = OxmlElement('w:rFonts')
            rpr.insert(0, fonts)
        for attr in ('w:ascii', 'w:hAnsi', 'w:cs', 'w:eastAsia'):
            fonts.set(qn(attr), font)
        for attr in ('w:asciiTheme', 'w:hAnsiTheme', 'w:cstheme', 'w:eastAsiaTheme'):
            fonts.attrib.pop(qn(attr), None)

    parts = [doc.element.body] + [s.header._element for s in doc.sections] + [s.footer._element for s in doc.sections]
    for part in parts:
        for run in part.iter(qn('w:r')):
            fix(run)
    styles = doc.styles.element
    for style in styles.iter(qn('w:style')):
        fix(style)
    # Font declarations elsewhere too (paragraph marks, table styles…)
    for part in parts + [styles]:
        for fonts in part.iter(qn('w:rFonts')):
            for attr in ('w:ascii', 'w:hAnsi', 'w:cs', 'w:eastAsia'):
                fonts.set(qn(attr), font)
            for attr in ('w:asciiTheme', 'w:hAnsiTheme', 'w:cstheme', 'w:eastAsiaTheme'):
                fonts.attrib.pop(qn(attr), None)
    defaults = styles.find(qn('w:docDefaults'))
    if defaults is not None:
        rpr_default = defaults.find(qn('w:rPrDefault'))
        if rpr_default is not None:
            fix(rpr_default)


def generate_piano_viaggi(template_path, out_docx_path, data):
    """
    data = {
        'event_name': '...',
        'date': '...',
        'destination': '...',
        'start_time': '...',
        'end_time': '...',
        'routes': [...],
        'exclude_autonomia': bool
    }
    """
    doc = Document(template_path)

    date_str = data.get('date', '').strip()
    prep = "dell'" if date_str.startswith(('1 ', '8 ', '11 ')) else "del "
    event_str = f"{data.get('event_name', '')} {prep}{date_str}"

    # 1. Replace Placeholders in Headers
    for p in doc.paragraphs:
        _replace_text_in_paragraph(p, 'NOME EVENTO  dell’ DATA', event_str)
        _replace_text_in_paragraph(p, 'SEDE', _shorten_address(data.get('destination', '')))
        _replace_text_in_paragraph(p, '8,30', _doc_time(data.get('start_time'), '8,30'))
        _replace_text_in_paragraph(p, '16,00', _doc_time(data.get('end_time'), '16,00'))
        
    for t in doc.tables:
        for r in t.rows:
            for c in r.cells:
                for p in c.paragraphs:
                    _replace_text_in_paragraph(p, 'NOME EVENTO  dell’ DATA', event_str)
                    _replace_text_in_paragraph(p, 'SEDE', _shorten_address(data.get('destination', '')))
                    _replace_text_in_paragraph(p, '8,30', _doc_time(data.get('start_time'), '8,30'))
                    _replace_text_in_paragraph(p, '16,00', _doc_time(data.get('end_time'), '16,00'))

    # 2. Find the marker where to insert dynamic tables
    # and find the Header Table
    header_table_idx = -1
    for i, t in enumerate(doc.tables):
        if len(t.rows) > 0 and t.rows[0].cells[0].text.strip() == "N°":
            header_table_idx = i
            break

    if header_table_idx != -1 and header_table_idx + 1 < len(doc.tables):
        base_tbl_element = copy.deepcopy(doc.tables[header_table_idx + 1]._tbl)
        
        # Remove all mock tables after the header table
        tables_to_remove = []
        for i in range(header_table_idx + 1, len(doc.tables)):
            tables_to_remove.append(doc.tables[i]._element)
        for tbl_elem in tables_to_remove:
            tbl_elem.getparent().remove(tbl_elem)

        # insertion point
        target_p = None
        for p in doc.paragraphs:
            if "Gli Istituti sotto riportati" in p.text:
                target_p = p
                break
        
        if not target_p:
            # Fallback
            target_p = doc.paragraphs[-1]

        # 3. Generate tables for each route, inserting right after the header table
        from docx.oxml.shared import OxmlElement
        last_inserted = doc.tables[header_table_idx]._element

        routes = data.get('routes', [])
        for route_idx, route in enumerate(routes):
            new_tbl_element = copy.deepcopy(base_tbl_element)
            t = Table(new_tbl_element, doc)
            
            # The base table usually has: Data Row 1, Data Row 2, Totals Row
            # Let's dynamically create rows for stops. We'll copy the first row,
            # clear all standard data rows, then append.
            data_row_template = copy.deepcopy(t.rows[0]._tr)
            totals_row_template = copy.deepcopy(t.rows[-1]._tr)
            
            # Remove all rows inside new_tbl_element
            for row_elem in list(new_tbl_element):
                if row_elem.tag.endswith('tr'):
                    new_tbl_element.remove(row_elem)
                    
            # Identify stops (only pickups)
            pickup_stops = [s for s in route.get('outbound', {}).get('stops', []) if s.get('type') == 'pickup']
            total_pax = 0
            
            from docx.shared import Pt
            def _set_cell_val(cell, text, size=10):
                cell.text = text
                if cell.paragraphs:
                    for run in cell.paragraphs[0].runs:
                        run.font.size = Pt(size)
                        run.font.name = 'Arial'
            
            first_fin_cell = None
            first_km_cell = None
            first_name_cell = None
            last_name = None
            first_time_cell = None
            last_time = None
            first_ret_time_cell = None
            last_ret_time = None

            for i, stop in enumerate(pickup_stops):
                stop_row_elem = copy.deepcopy(data_row_template)
                new_tbl_element.append(stop_row_elem)
                # re-wrap to modify
                temp_t = Table(new_tbl_element, doc)
                current_row = temp_t.rows[-1]

                if i == 0:
                    _set_cell_val(current_row.cells[0], f"Fin {route.get('vehicle_id', route_idx) + 1}", size=9)
                    _set_cell_val(current_row.cells[1], _doc_km(route.get('outbound', {}).get('distance', 0) * 2), size=11)
                    first_fin_cell = current_row.cells[0]
                    first_km_cell = current_row.cells[1]
                else:
                    _set_cell_val(current_row.cells[0], "")
                    _set_cell_val(current_row.cells[1], "")
                    first_fin_cell.merge(current_row.cells[0])
                    first_km_cell.merge(current_row.cells[1])

                # Istituto/Name (colonna 2) — merge consecutive identical names
                name = stop.get('name', '')
                if i > 0 and name and name == last_name:
                    _set_cell_val(current_row.cells[2], "")
                    first_name_cell.merge(current_row.cells[2])
                else:
                    _set_cell_val(current_row.cells[2], name)
                    first_name_cell = current_row.cells[2]
                    last_name = name

                # Orario Andata (colonna 3)
                current_time = stop.get('departure_time', '')
                if i > 0 and current_time and current_time == last_time:
                    _set_cell_val(current_row.cells[3], "")
                    first_time_cell.merge(current_row.cells[3])
                else:
                    _set_cell_val(current_row.cells[3], current_time)
                    first_time_cell = current_row.cells[3]
                    last_time = current_time

                _set_cell_val(current_row.cells[4], _doc_place(stop.get('display_address') or stop.get('address', '')))
                _set_cell_val(current_row.cells[5], str(stop.get('count', '0')))

                # Orario Ritorno (colonna 6)
                current_ret_time = stop.get('return_time', '')
                if i > 0 and current_ret_time and current_ret_time == last_ret_time:
                    _set_cell_val(current_row.cells[6], "")
                    first_ret_time_cell.merge(current_row.cells[6])
                else:
                    _set_cell_val(current_row.cells[6], current_ret_time)
                    first_ret_time_cell = current_row.cells[6]
                    last_ret_time = current_ret_time

                total_pax += stop.get('count', 0)
                
            # Append Totals row
            new_tbl_element.append(totals_row_template)
            temp_t = Table(new_tbl_element, doc)
            totals_row = temp_t.rows[-1]
            # Passenger total: bold, aligned like the numbers above it; the "TOTALE PAX"
            # label keeps a little room from its cell's right edge
            pax_cell = totals_row.cells[-2]
            _set_cell_val(pax_cell, str(total_pax), size=11)
            pax_par = pax_cell.paragraphs[0]
            count_par = current_row.cells[5].paragraphs[0] if pickup_stops else None
            if count_par is not None:
                pax_par.alignment = count_par.alignment
                pax_par.paragraph_format.left_indent = count_par.paragraph_format.left_indent
                pax_par.paragraph_format.right_indent = count_par.paragraph_format.right_indent
                # Same cell margins as the numbers above
                src_mar = current_row.cells[5]._tc.tcPr.find(qn('w:tcMar')) if current_row.cells[5]._tc.tcPr is not None else None
                if src_mar is not None:
                    tcpr = pax_cell._tc.get_or_add_tcPr()
                    old_mar = tcpr.find(qn('w:tcMar'))
                    if old_mar is not None:
                        tcpr.remove(old_mar)
                    tcpr.append(copy.deepcopy(src_mar))
            for run in pax_par.runs:
                run.bold = True
            for par in totals_row.cells[0].paragraphs:
                par.paragraph_format.right_indent = Cm(0.2)
            
            # Insert table immediately after the previous element (no gap)
            last_inserted.addnext(new_tbl_element)
            p_elem = OxmlElement('w:p')
            new_tbl_element.addnext(p_elem)
            last_inserted = p_elem

        # 4. Handle generic exclusions at the end
        if data.get('exclude_autonomia', False):
            # Remove all paragraphs starting from "Gli Istituti"
            found_autonomia = False
            for p in doc.paragraphs:
                if "Gli Istituti sotto riportati" in p.text:
                    found_autonomia = True
                if found_autonomia:
                    # Remove
                    p_element = p._element
                    p_element.getparent().remove(p_element)

    _use_one_font(doc, 'Arial')
    doc.save(out_docx_path)
    return out_docx_path


def generate_richiesta_servizio(template_path, out_docx_path, data):
    # For Richiesta servizio it uses an almost identical structure.
    return generate_piano_viaggi(template_path, out_docx_path, data)
