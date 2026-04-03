import os
import time
import threading
import requests as req
from dotenv import load_dotenv
import nominatim_cache

_thread_local = threading.local()

def set_status_updater(fn):
    """Set a per-thread callback fn(message, extra_seconds) called on rate-limit retries."""
    _thread_local.status_fn = fn

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
    Search OpenStreetMap Nominatim for address suggestions in Italy (Trentino region).
    Use this tool for every address to find the best real-world match.
    Returns up to 5 candidate addresses — you must pick the most appropriate one.

    Args:
        location: the raw address string to search for

    Returns:
        A numbered list of up to 5 candidate addresses from OSM Nominatim, or an error message.
    """
    try:
        cached = nominatim_cache.get(location, 5)
        if cached is not None:
            if not cached:
                return f"No results found for: {location}"
            lines = [f"{i}. {item['display_name']}" for i, item in enumerate(cached[:5], 1)]
            return "\n".join(lines)
        for attempt in range(4):
            time.sleep(1 + attempt * 2)  # 1s, 3s, 5s, 7s — backoff on retry
            resp = req.get(
                'https://nominatim.openstreetmap.org/search',
                params={
                    'q': location,
                    'format': 'json',
                    'countrycodes': 'it',
                    'limit': 5,
                    'viewbox': '10.4,45.6,12.2,46.95',  # Trentino-Alto Adige bounding box
                    'bounded': 0,
                },
                headers={
                    'User-Agent': 'BusPlan/1.0 (bus route optimizer for Trentino schools)',
                },
                timeout=6
            )
            if resp.status_code == 429:
                next_sleep = 1 + (attempt + 1) * 2
                fn = getattr(_thread_local, 'status_fn', None)
                if callable(fn):
                    fn(f"Rate limit Nominatim — retry tra {next_sleep}s (AI in corso...)", next_sleep)
                continue  # rate limited — retry with longer sleep
            break
        if resp.status_code != 200:
            return f"No results found for: {location} (HTTP {resp.status_code})"
        try:
            data = resp.json()
        except ValueError:
            return f"No results found for: {location} (invalid response)"

        nominatim_cache.store(location, 5, data)  # cache even if empty
        if not data:
            return f"No results found for: {location}"
        lines = [f"{i}. {item['display_name']}" for i, item in enumerate(data[:5], 1)]
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
    address_data = [{"name": "IC Levico terme", "address": "Tenna , Via Albere 2"},{"name": "IC Cles", "address": "PIAZZA FIERA - CLES"}]
    print(call_agent(str(address_data)))