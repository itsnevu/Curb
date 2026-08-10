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
    # Cost & loop: arahkan base_url ke gateway, tempelkan run id.
    llm = ChatOpenAI(
        model="gpt-4o",
        base_url="http://localhost:8080/v1",
        default_headers=curb.gateway_headers(),
    )

    # Guardrail: bungkus fungsinya sebelum dijadikan tool LangChain.
    @tool
    def delete_file(path: str) -> str:
        """Hapus sebuah file."""
        return curb.wrap_tool(_delete, name="delete_file", sensitivity="high")(path)

    def _delete(path: str) -> str:
        return f"terhapus {path}"

    prompt = ChatPromptTemplate.from_messages(
        [("system", "Kamu asisten operasi."), ("human", "{input}"), ("placeholder", "{agent_scratchpad}")]
    )
    agent = AgentExecutor(agent=create_tool_calling_agent(llm, [delete_file], prompt), tools=[delete_file])
    print(agent.invoke({"input": "Bersihkan /tmp/cache.db"})["output"])
