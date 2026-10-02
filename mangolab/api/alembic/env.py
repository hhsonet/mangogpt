from alembic import context
from sqlalchemy import create_engine, pool

from app.config import get_settings
from app.models import SCHEMA, Base

target_metadata = Base.metadata


def include_object(obj, name, type_, reflected, compare_to):
    # Only manage the mangolab schema; never touch MangoGPT's tables.
    if getattr(obj, "info", {}).get("managed_elsewhere"):
        return False
    if type_ == "table" and getattr(obj, "schema", None) != SCHEMA:
        return False
    return True


def run() -> None:
    engine = create_engine(get_settings().database_url, poolclass=pool.NullPool)
    with engine.connect() as conn:
        context.configure(
            connection=conn, target_metadata=target_metadata, include_schemas=True, include_object=include_object,
            version_table_schema=SCHEMA, compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


run()
