"""MangoLab tables (schema `mangolab`). Managed by Alembic. Users live in MangoGPT's `public."User"` and are only referenced."""
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Index, Integer, MetaData, Table, Text, UniqueConstraint, text
from sqlalchemy import Column
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

SCHEMA = "mangolab"
metadata = MetaData(schema=SCHEMA)


class Base(DeclarativeBase):
    metadata = metadata


# Stub of MangoGPT's User table so foreign keys resolve. Never created or altered by Alembic.
PublicUser = Table("User", metadata, Column("id", Text, primary_key=True), schema="public", info={"managed_elsewhere": True})
USER_FK = "public.User.id"

_now = text("now()")
_uuid = text("gen_random_uuid()")


def _user_fk(**kw) -> Mapped[str]:
    return mapped_column(Text, ForeignKey(USER_FK, ondelete="CASCADE"), **kw)


class LabAccess(Base):
    """Who may use MangoLab, and their resource limits. Off by default; admins always have access."""
    __tablename__ = "lab_access"
    user_id: Mapped[str] = _user_fk(primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    gpu_budget_mib: Mapped[int] = mapped_column(Integer, server_default=text("4096"))
    cpu_quota_pct: Mapped[int] = mapped_column(Integer, server_default=text("200"))  # 200 = two cores
    mem_max_mb: Mapped[int] = mapped_column(Integer, server_default=text("6144"))
    disk_quota_mb: Mapped[int] = mapped_column(Integer, server_default=text("20480"))
    max_runtimes: Mapped[int] = mapped_column(Integer, server_default=text("1"))
    idle_timeout_min: Mapped[int] = mapped_column(Integer, server_default=text("60"))
    granted_by: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now)


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (UniqueConstraint("owner_id", "slug"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=_uuid)
    owner_id: Mapped[str] = _user_fk(index=True)
    name: Mapped[str] = mapped_column(Text)
    slug: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text, server_default="")
    workspace_path: Mapped[str] = mapped_column(Text)  # relative to MANGOLAB_DATA_DIR
    archived: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now)
    last_opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ProjectMember(Base):
    __tablename__ = "project_members"
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.projects.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[str] = _user_fk(primary_key=True)
    role: Mapped[str] = mapped_column(Text, server_default="viewer")  # editor | viewer


class Notebook(Base):
    """Metadata only. The .ipynb file in the workspace is the source of truth."""
    __tablename__ = "notebooks"
    __table_args__ = (UniqueConstraint("project_id", "path"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=_uuid)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.projects.id", ondelete="CASCADE"), index=True)
    path: Mapped[str] = mapped_column(Text)
    name: Mapped[str] = mapped_column(Text)
    kernel_name: Mapped[str] = mapped_column(Text, server_default="python3")
    size_bytes: Mapped[int] = mapped_column(BigInteger, server_default=text("0"))
    etag: Mapped[str] = mapped_column(Text, server_default="")
    version: Mapped[int] = mapped_column(Integer, server_default=text("1"))
    last_saved_by: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_saved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now)


class NotebookRevision(Base):
    __tablename__ = "notebook_revisions"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=_uuid)
    notebook_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.notebooks.id", ondelete="CASCADE"), index=True)
    created_by: Mapped[str | None] = mapped_column(Text, nullable=True)
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(Text)
    storage_path: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now)


class Runtime(Base):
    """One running (or recently stopped) runtime per project: a Kernel Gateway plus its kernels and terminals in one resource-limited group."""
    __tablename__ = "runtimes"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=_uuid)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.projects.id", ondelete="CASCADE"), index=True)
    owner_id: Mapped[str] = _user_fk(index=True)
    status: Mapped[str] = mapped_column(Text, server_default="starting")  # starting | idle | busy | stopping | stopped | error
    driver: Mapped[str] = mapped_column(Text, server_default="systemd-user")
    unit_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    port: Mapped[int | None] = mapped_column(Integer, nullable=True)
    gpu_budget_mib: Mapped[int] = mapped_column(Integer)
    cpu_quota_pct: Mapped[int] = mapped_column(Integer)
    mem_max_mb: Mapped[int] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now)
    last_activity_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now)
    stopped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class KernelSession(Base):
    __tablename__ = "kernel_sessions"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=_uuid)
    runtime_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.runtimes.id", ondelete="CASCADE"), index=True)
    notebook_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.notebooks.id", ondelete="SET NULL"), nullable=True)
    kernel_id: Mapped[str] = mapped_column(Text)
    kernel_name: Mapped[str] = mapped_column(Text, server_default="python3")
    status: Mapped[str] = mapped_column(Text, server_default="starting")
    execution_count: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now)
    last_activity_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now)


class Execution(Base):
    """Run history (audit and usage). Stores the cell id and outcome, not the code or its output."""
    __tablename__ = "executions"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=_uuid)
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.kernel_sessions.id", ondelete="SET NULL"), nullable=True, index=True)
    notebook_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.notebooks.id", ondelete="SET NULL"), nullable=True, index=True)
    user_id: Mapped[str] = _user_fk(index=True)
    cell_id: Mapped[str] = mapped_column(Text)
    msg_id: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, server_default="queued")  # queued | running | ok | error | aborted | died
    error_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    queued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)


class Terminal(Base):
    __tablename__ = "terminals"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=_uuid)
    runtime_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.runtimes.id", ondelete="CASCADE"), index=True)
    owner_id: Mapped[str] = _user_fk()
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PackageJob(Base):
    __tablename__ = "package_jobs"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=_uuid)
    runtime_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.runtimes.id", ondelete="SET NULL"), nullable=True)
    user_id: Mapped[str] = _user_fk(index=True)
    specs: Mapped[list[str]] = mapped_column(ARRAY(Text))
    status: Mapped[str] = mapped_column(Text, server_default="running")  # running | ok | error
    exit_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    log_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ResourceSample(Base):
    """Short-lived per-runtime usage history for charts. Pruned by the monitor."""
    __tablename__ = "resource_samples"
    __table_args__ = (Index("ix_resource_samples_runtime_ts", "runtime_id", "ts"),)
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    runtime_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.runtimes.id", ondelete="CASCADE"))
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now)
    cpu_pct: Mapped[float | None] = mapped_column(nullable=True)
    ram_mb: Mapped[int | None] = mapped_column(Integer, nullable=True)
    gpu_mem_mib: Mapped[int | None] = mapped_column(Integer, nullable=True)


class AiThread(Base):
    __tablename__ = "ai_threads"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=_uuid)
    user_id: Mapped[str] = _user_fk(index=True)
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.projects.id", ondelete="CASCADE"), nullable=True, index=True)
    notebook_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.notebooks.id", ondelete="SET NULL"), nullable=True)
    title: Mapped[str] = mapped_column(Text, server_default="New conversation")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now)


class AiMessage(Base):
    __tablename__ = "ai_messages"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=_uuid)
    thread_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.ai_threads.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(Text)  # user | assistant | tool
    content: Mapped[str] = mapped_column(Text)
    context_meta: Mapped[dict | None] = mapped_column(JSONB, nullable=True)  # what was shown to the model (cell ids, files), not the content
    model: Mapped[str | None] = mapped_column(Text, nullable=True)
    tokens_in: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tokens_out: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now)


class AiAction(Base):
    """A change the assistant proposed. Nothing happens until the user applies it."""
    __tablename__ = "ai_actions"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=_uuid)
    message_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.ai_messages.id", ondelete="CASCADE"), index=True)
    type: Mapped[str] = mapped_column(Text)  # insert_cell | edit_cell | install_package | run_cell
    payload: Mapped[dict] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(Text, server_default="proposed")  # proposed | applied | rejected
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
