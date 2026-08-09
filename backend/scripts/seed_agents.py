# backend/scripts/seed_agents.py
"""Seed a handful of agents for local development. Agent creation is
explicitly out of scope for the API (see spec NFR #1) -- this script is the
only way agents enter the system.

Idempotent: seeds only when the agents table is empty, so it is safe to run on
every container start and safe to re-run by hand. The emptiness check is the
guard -- once real agents exist, this never touches the table again.

Run as a MODULE, not a file path -- the project is not installed as a package,
so `python scripts/seed_agents.py` puts scripts/ on sys.path instead of the
backend directory and cannot import `app`:

    uv run python -m scripts.seed_agents
"""

from sqlalchemy import func, select, text

from app.components.agents.model import Agent
from app.db import db_session_write

SEED_NAMES = [
    "Alice Chen",
    "Bob Martinez",
    "Carol Singh",
    "David Okafor",
    "Elena Petrova",
]

# Two-argument advisory lock. Postgres keeps single-key and key-pair advisory
# locks in separate spaces, so this cannot collide with the single-key
# pg_advisory_xact_lock(agent_id) taken by assignment_service.
_SEED_LOCK_NAMESPACE = 85210
_SEED_LOCK_KEY = 1


def seed_agents_if_empty() -> int:
    """Insert the seed agents iff the table is empty. Returns how many were
    inserted (0 when it was already populated)."""
    with db_session_write() as session:
        # Serialise concurrent boots: with more than one backend replica, two
        # containers can otherwise both observe an empty table and both seed,
        # producing duplicates. The lock is transaction-scoped and released on
        # commit, so the loser sees the winner's rows and skips.
        session.execute(
            text("SELECT pg_advisory_xact_lock(:ns, :key)"),
            {"ns": _SEED_LOCK_NAMESPACE, "key": _SEED_LOCK_KEY},
        )

        existing = session.scalar(select(func.count()).select_from(Agent))
        if existing:
            print(f"agents table already has {existing} row(s) — skipping seed")
            return 0

        for name in SEED_NAMES:
            session.add(Agent(name=name, email=f"{name.split()[0].lower()}@richpanel.example"))

    print(f"seeded {len(SEED_NAMES)} agents")
    return len(SEED_NAMES)


if __name__ == "__main__":
    seed_agents_if_empty()
