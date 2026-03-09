import os
from dotenv import load_dotenv

# Clients
from datapizza.clients.google import GoogleClient
from datapizza.agents import Agent
from gemini_SYSTEM_PROMPT import SYSTEM_PROMPT

# Pydantic base model
from pydantic import BaseModel

load_dotenv()

# Google Gemini
client = GoogleClient(
    api_key=os.getenv("GOOGLE_API_KEY"),
    model = "gemini-flash-latest",
    system_prompt = SYSTEM_PROMPT,
)

class Address(BaseModel):
    id: int
    address: str
    
    
# def call_llm(user_input):
#     """
#     Sends *prompt* to Gemini and returns the raw text response.

#     To use the datapizza-ai framework instead, replace this method body:

#         from datapizza_ai import Agent   # or whatever the import looks like
#         agent = Agent(model="gemini-1.5-flash")
#         return agent.run(prompt)
#     """
#     response = client.structured_response(input=user_input, output_cls=Address)
#     return response

from datapizza.tools.duckduckgo import DuckDuckGoSearchTool

web_search_agent = Agent(
    name="web_search_agent",
    client=client,
    system_prompt=SYSTEM_PROMPT,
    tools=[DuckDuckGoSearchTool()],
)

def call_agent(user_input):
    """
    Sends *prompt* to Gemini and returns the raw text response.
    """
    response = web_search_agent.run(user_input)
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