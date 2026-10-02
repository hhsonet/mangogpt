#!/usr/bin/env bash
# Start/stop/status for the user-space PostgreSQL 16 cluster (data in ~/pgdata, listens on 127.0.0.1:5432).
# Usage: scripts/postgres.sh start|stop|restart|status
source "$HOME/.local/pg16/env.sh"
case "${1:-status}" in
  start)   pg_ctl -D "$PGDATA" -l "$PGDATA/server.log" -w start ;;
  stop)    pg_ctl -D "$PGDATA" -m fast -w stop ;;
  restart) pg_ctl -D "$PGDATA" -l "$PGDATA/server.log" -m fast -w restart ;;
  status)  pg_ctl -D "$PGDATA" status; pg_isready -h 127.0.0.1 -p 5432 ;;
  *) echo "usage: $0 start|stop|restart|status" >&2; exit 2 ;;
esac
