import os
import requests as req
from dotenv import load_dotenv

# Clients
from datapizza.clients.google import GoogleClient
from datapizza.agents import Agent
from gemini_SYSTEM_PROMPT import SYSTEM_PROMPT

# Pydantic base model
from pydantic import BaseModel

load_dotenv()

from datapizza.tools.duckduckgo import DuckDuckGoSearchTool
from datapizza.tools import tool

class Address(BaseModel):
    id: int
    address: str


@tool
def geocodingTool(location: str) -> str:
    """
    Search Google Maps Places for address suggestions in Italy (Trentino region).
    Use this tool for every address to find the best real-world match.
    Returns up to 5 candidate addresses — you must pick the most appropriate one.

    Args:
        location: the raw address string to search for

    Returns:
        A numbered list of up to 5 candidate addresses from Google Maps, or an error message.
    """
    api_key = os.getenv('GOOGLE_MAPS_API_KEY')
    if not api_key:
        return "Error: GOOGLE_MAPS_API_KEY not configured."

    try:
        resp = req.get(
            'https://maps.googleapis.com/maps/api/place/autocomplete/json',
            params={
                'input': location,
                'key': api_key,
                'language': 'it',
                'components': 'country:it',
                'location': '46.0697,11.1211',   # Trentino bias
                'radius': 100000,
            },
            timeout=6
        )
        data = resp.json()
        predictions = data.get('predictions', [])

        if not predictions:
            return f"No results found for: {location}"

        lines = [f"{i}. {p['description']}" for i, p in enumerate(predictions[:5], 1)]
        return "\n".join(lines)

    except Exception as e:
        return f"Tool error: {e}"


# Module-level default agent (used only by call_agent).
# Wrapped in try-except so that a missing/invalid GOOGLE_API_KEY at startup
# does NOT prevent the module from being imported.
_default_agent = None
try:
    _default_client = GoogleClient(
        api_key=os.getenv("GOOGLE_API_KEY"),
        model="gemini-flash-latest",
        system_prompt=SYSTEM_PROMPT,
    )
    _default_agent = Agent(
        name="address_resolver_agent",
        client=_default_client,
        system_prompt=SYSTEM_PROMPT,
        tools=[geocodingTool],
    )
except Exception as _e:
    print(f"[gemini_agent] Default agent init failed (key missing or invalid?): {_e}")


def call_agent(user_input):
    """Sends *prompt* to the default Gemini agent."""
    if _default_agent is None:
        raise RuntimeError("Default agent not initialised — check GOOGLE_API_KEY")
    response = _default_agent.run(user_input)
    return response.text


def call_agent_with_key(user_input, api_key):
    """
    Creates a fresh agent with the given *api_key* and runs it.
    Used by AddressCorrector for API-key rotation on rate-limit errors.
    """
    temp_client = GoogleClient(
        api_key=api_key,
        model="gemini-flash-latest",
        system_prompt=SYSTEM_PROMPT,
    )
    temp_agent = Agent(
        name="address_resolver_agent",
        client=temp_client,
        system_prompt=SYSTEM_PROMPT,
        tools=[geocodingTool],
    )
    response = temp_agent.run(user_input)
    return response.text


if __name__ == "__main__":
    address_data = [{"id": "IC Levico terme", "address": "Tenna , Via Albere 2"},{"id": "IC Cles", "address": "PIAZZA FIERA - CLES"}]
    print(call_agent(str(address_data)))

## TEST
# Note: we need to change everywhere id -> name 

address_data = [
    {
        "name": "IC Levico Terme",
        "address": "Tenna , Via Albere 2",
        "normalized_address": "Via delle Albere 2, 38050 Tenna, Trentino-Alto Adige, Italia"
    },
    {
        "name": "IC Cles",
        "address": "PIAZZA FIERA - CLES",
        "normalized_address": "Piazza Fiera 1, 38023 Cles, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Liceo Galilei Trento",
        "address": "liceo galiei trento via previtali 3",
        "normalized_address": "Via Prepositura 3, 38122 Trento, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola media Pergine",
        "address": "pergine valsugna via reggina elena 20",
        "normalized_address": "Via Regina Elena 20, 38057 Pergine Valsugana, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola media Rovereto",
        "address": "scuole medie rovereto in via benacense",
        "normalized_address": "Via Benacense 14, 38068 Rovereto, Trentino-Alto Adige, Italia"
    },
    {
        "name": "ITC Fontana Rovereto",
        "address": "ITC Fontana roveteto, via Balteri",
        "normalized_address": "Via Balteri 4, 38068 Rovereto, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola primaria Levico",
        "address": "levico terme via roma scuola elementare",
        "normalized_address": "Via Roma 30, 38056 Levico Terme, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola media Riva del Garda",
        "address": "riva del garda, viale prandi scuole",
        "normalized_address": "Viale Giuseppe Prati 4, 38066 Riva del Garda, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola media Arco",
        "address": "arco tn, via capitelli vicino al centro storico",
        "normalized_address": "Via dei Capitelli 15, 38062 Arco, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola superiore Tione",
        "address": "scuola superiore tione, via durighelo 8",
        "normalized_address": "Via Durighello 8, 38079 Tione di Trento, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola media Cavalese",
        "address": "cavalese, scuola in via bronzeti",
        "normalized_address": "Via Francesco Bronzetti 5, 38033 Cavalese, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola media Bressanone",
        "address": "bressanone liceo, via bruno buozi",
        "normalized_address": "Via Bruno Buozzi 10, 39042 Bressanone, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola media Brunico",
        "address": "brunico, via gilm 5 scuole medie",
        "normalized_address": "Via Gilm 5, 39031 Brunico, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola media Egna",
        "address": "egna, scuola in via marcony 7",
        "normalized_address": "Via Guglielmo Marconi 7, 39044 Egna, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola media Lavis",
        "address": "lavis, scuola media in via zandonay",
        "normalized_address": "Via Riccardo Zandonai 1, 38015 Lavis, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola media Mezzolombardo",
        "address": "mezzolombardo, istituto in via damiano chesa",
        "normalized_address": "Via Damiano Chiesa 2, 38017 Mezzolombardo, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola elementare Roncegno",
        "address": "roncegno terme, scuola elementare in via roma 10",
        "normalized_address": "Via Roma 10, 38050 Roncegno Terme, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola primaria Pinzolo",
        "address": "pinzolo scuola, via al sole",
        "normalized_address": "Via al Sole 3, 38086 Pinzolo, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola media Predazzo",
        "address": "predazzo, scuole in via fiamme gialle",
        "normalized_address": "Via Fiamme Gialle 12, 38037 Predazzo, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola media Borgo Valsugana",
        "address": "borgo valsugana, scuola in via per tesino 5",
        "normalized_address": "Via per Tesino 5, 38051 Borgo Valsugana, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola primaria Andalo",
        "address": "andalo tn, scuole vicino via priori",
        "normalized_address": "Via Priori 2, 38010 Andalo, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Istituto agrario San Michele",
        "address": "san michele all adige, istituto agrario",
        "normalized_address": "Via Edmund Mach 1, 38010 San Michele all'Adige, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola media Ala",
        "address": "ala trentino, scuole medie in via papa giovanni",
        "normalized_address": "Via Papa Giovanni XXIII 4, 38061 Ala, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola media Mori",
        "address": "mori tn, via teatro scuola",
        "normalized_address": "Via Teatro 12, 38065 Mori, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola media Madonna di Campiglio",
        "address": "madonna di campiglio, scuola in centro paese",
        "normalized_address": "Viale Dolomiti di Brenta 27, 38086 Madonna di Campiglio, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Liceo Walther Bolzano",
        "address": "liceo classico walter, piazza walter bolzano",
        "normalized_address": "Piazza Walther 1, 39100 Bolzano, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola media via Claudia Augusta",
        "address": "bolzano, scuola in via claudia agusta 2",
        "normalized_address": "Via Claudia Augusta 2, 39100 Bolzano, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola elementare via Roma Merano",
        "address": "merano, scuola elementare di via roma",
        "normalized_address": "Via Roma 160, 39012 Merano, Trentino-Alto Adige, Italia"
    },
    {
        "name": "Scuola superiore Merano",
        "address": "istituto superiore merano, via keplro 3",
        "normalized_address": "Via Keplero 3, 39012 Merano, Trentino-Alto Adige, Italia"
    }
]