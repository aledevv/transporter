"""Document export: values written the way the client's templates write them."""
import os
import zipfile

from document_generator import _shorten_address, _doc_time, _doc_km, _doc_place, generate_piano_viaggi

TEMPLATE = os.path.join(os.path.dirname(__file__), '..', 'template_documents', 'Piano_Viaggi_TIPO.docx')


def test_destination_drops_administrative_tail():
    full = 'Villa Lagarina, Comunità della Vallagarina, Provincia di Trento, Trentino-Alto Adige/Südtirol, Italia'
    assert _shorten_address(full) == 'Villa Lagarina'
    assert _shorten_address('Via Durone, 53, Tione di Trento, 38079, Italia') == 'Via Durone, 53, Tione di Trento'


def test_times_and_km_in_italian_format():
    assert _doc_time('11:45', '8,30') == '11,45'
    assert _doc_time('08:00', '8,30') == '8,00'
    assert _doc_time('', '8,30') == '8,30'
    assert _doc_km(132_700) == '132,7 km'


def test_coordinates_are_not_printed_as_meeting_place():
    assert _doc_place('46.28885399629256, 11.51090522349365') == ''
    assert _doc_place('Piazza Fiera, Cles') == 'Piazza Fiera, Cles'


def test_generated_plan(tmp_path):
    out = tmp_path / 'piano.docx'
    route = {'vehicle_id': 0, 'outbound': {'distance': 66_350, 'stops': [
        {'type': 'pickup', 'name': 'IC ALA', 'departure_time': '10:20', 'return_time': '17:38', 'count': 15,
         'display_address': 'ALA, Via Betta, Scuola primaria'},
        {'type': 'destination', 'arrival_time': '11:45'},
    ]}}
    generate_piano_viaggi(TEMPLATE, str(out), {
        'event_name': 'Corsa Campestre IS', 'date': '12 novembre 2026',
        'destination': 'Villa Lagarina, Comunità della Vallagarina, Provincia di Trento, Italia',
        'start_time': '11:45', 'end_time': '16:15', 'exclude_autonomia': True, 'routes': [route],
    })
    with zipfile.ZipFile(out) as z:
        xml = z.read('word/document.xml').decode() + z.read('word/styles.xml').decode()
    import re
    text = re.sub(r'<[^>]+>', '', xml)
    assert 'Villa Lagarina' in text and 'Comunità' not in text
    assert '11,45' in text and '16,15' in text
    assert '132,7 km' in text
    assert 'ALA, Via Betta, Scuola primaria' in text
    # The template's base style must name a real font (it used to say "Helvetica, Arial")
    assert 'Helvetica, Arial' not in xml


def test_one_font_everywhere_and_bold_total(tmp_path):
    import re
    out = tmp_path / 'piano.docx'
    route = {'vehicle_id': 0, 'outbound': {'distance': 10_000, 'stops': [
        {'type': 'pickup', 'name': 'IC ALA', 'departure_time': '10:20', 'return_time': '17:38', 'count': 52, 'display_address': 'Ala'},
        {'type': 'destination', 'arrival_time': '11:45'},
    ]}}
    generate_piano_viaggi(TEMPLATE, str(out), {'event_name': 'Prova', 'date': '1 dicembre 2026', 'destination': 'Rovereto',
                                               'start_time': '9:00', 'end_time': '12:00', 'exclude_autonomia': True, 'routes': [route]})
    with zipfile.ZipFile(out) as z:
        xml = z.read('word/document.xml').decode() + z.read('word/styles.xml').decode()
    fonts = set()
    for tag in re.findall(r'<w:rFonts[^>]*/>', xml):
        fonts |= set(re.findall(r'w:(?:ascii|hAnsi|cs|eastAsia)="([^"]+)"', tag))
    assert fonts == {'Arial'}
    # The passenger total is bold
    doc_xml = zipfile.ZipFile(out).read('word/document.xml').decode()
    assert re.search(r'<w:b/>.{0,400}?<w:t[^>]*>52</w:t>', doc_xml, re.S)
