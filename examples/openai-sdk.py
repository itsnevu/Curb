"""Perlindungan nol-kode: cukup ganti base_url ke gateway Curb.

pip install openai curb-sdk
"""
from openai import OpenAI
from curb import Curb

curb = Curb(base_url="http://localhost:8090")

with curb.run() as run_id:
    client = OpenAI(
        base_url="http://localhost:8080/v1",   # ← satu-satunya perubahan
        default_headers=curb.gateway_headers(),
    )
    for i in range(100):
        # Saat cost cap / loop detect nyala, ini melempar error 429 dari gateway
        # dan agent berhenti dengan sendirinya.
        r = client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": f"langkah {i}"}],
        )
        print(r.choices[0].message.content)
