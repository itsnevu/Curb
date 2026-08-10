"""LangChain Python + Curb.

pip install langchain langchain-openai curb-sdk
"""
from langchain.agents import create_tool_calling_agent, AgentExecutor
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI

from curb import Curb

curb = Curb(base_url="http://localhost:8090")

with curb.run():
    # Cost and loops: point base_url at the gateway and attach the run id.
    llm = ChatOpenAI(
        model="gpt-4o",
        base_url="http://localhost:8080/v1",
        default_headers=curb.gateway_headers(),
    )

    # Guardrail: wrap the function before turning it into a LangChain tool.
    @tool
    def delete_file(path: str) -> str:
        """Delete a file."""
        return curb.wrap_tool(_delete, name="delete_file", sensitivity="high")(path)

    def _delete(path: str) -> str:
        return f"deleted {path}"

    prompt = ChatPromptTemplate.from_messages(
        [("system", "You are an operations assistant."), ("human", "{input}"), ("placeholder", "{agent_scratchpad}")]
    )
    agent = AgentExecutor(agent=create_tool_calling_agent(llm, [delete_file], prompt), tools=[delete_file])
    print(agent.invoke({"input": "Clean up /tmp/cache.db"})["output"])
