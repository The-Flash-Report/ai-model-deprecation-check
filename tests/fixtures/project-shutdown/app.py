import os

# A service still pinned to a retired model snapshot.
MODEL = "gpt-4-0314"


def ask(prompt: str) -> str:
    return call_llm(model=MODEL, prompt=prompt, temperature=0.2)
