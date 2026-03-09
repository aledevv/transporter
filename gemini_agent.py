import os
from dotenv import load_dotenv

# Clients
from datapizza.clients.google import GoogleClient
from datapizza.agents import Agent
from gemini_SYSTEM_PROMPT import SYSTEM_PROMPT

# Pydantic base model
from pydantic import BaseModel

load_dotenv()

from datapizza.tools.duckduckgo import DuckDuckGoSearchTool

class Address(BaseModel):
    id: int
    address: str


# Module-level default agent (used only by call_agent).
# Wrapped in try-except so that a missing/invalid GOOGLE_API_KEY at startup
# does NOT prevent the module from being imported — call_agent_with_key creates
# its own fresh client on every call and is unaffected by this block.
_default_agent = None
try:
    _default_client = GoogleClient(
        api_key=os.getenv("GOOGLE_API_KEY"),
        model="gemini-flash-latest",
        system_prompt=SYSTEM_PROMPT,
    )
    _default_agent = Agent(
        name="web_search_agent",
        client=_default_client,
        system_prompt=SYSTEM_PROMPT,
        tools=[DuckDuckGoSearchTool()],
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
        name="web_search_agent",
        client=temp_client,
        system_prompt=SYSTEM_PROMPT,
        tools=[DuckDuckGoSearchTool()],
    )
    response = temp_agent.run(user_input)
    return response.text

if __name__ == "__main__":

    address_data = {"id": "scuola1","address": "Via Biasi, 1 - 38010 SAN MICHELE ALL'ADIGE" }
    
    # print(call_llm(str(address_data)).structured_data[0])
    print(call_agent(str(address_data)))