# backend/scripts/seed_agents.py
"""Seed a handful of agents for local development. Agent creation is
explicitly out of scope for the API (see spec NFR #1) -- this script is the
only way agents enter the system."""

from app.components.agents.model import Agent
from app.db import db_session_write

SEED_NAMES = [
    "Alice Chen",
    "Bob Martinez",
    "Carol Singh",
    "David Okafor",
    "Elena Petrova",
]

if __name__ == "__main__":
    with db_session_write() as session:
        for name in SEED_NAMES:
            session.add(Agent(name=name, email=f"{name.split()[0].lower()}@richpanel.example"))
    print(f"seeded {len(SEED_NAMES)} agents")
