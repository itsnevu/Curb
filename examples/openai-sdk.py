"""Zero-code protection: just point base_url at the Curb gateway.

pip install openai curb-sdk
"""
from openai import OpenAI
from curb import Curb

curb = Curb(base_url="http://localhost:8090")

with curb.run() as run_id:
    client = OpenAI(
        base_url="http://localhost:8080/v1",   # ← the only change
        default_headers=curb.gateway_headers(),   # carries the key AND the run id
    )
    for i in range(100):
        # When the cost cap or loop breaker trips, this raises a 429 from the
        # gateway and the agent stops on its own.
        r = client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": f"step {i}"}],
        )
        print(r.choices[0].message.content)
