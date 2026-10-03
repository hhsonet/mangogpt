from app.services.assistant import _fit
from app.services.assistant_context import CtxCell, NotebookContext, build_context_text, cell_number, clip


def nb(n, selected=None, big=False):
    cells = [CtxCell(id=f"c{i}", source=(f"# {i}\n" + "x = 1\n" * 800) if big else f"x = {i}", output="out " * (600 if big else 1), execution_count=i) for i in range(1, n + 1)]
    return NotebookContext(path="a.ipynb", cells=cells, selected=selected)


def test_cell_numbers_accept_numbers_ids_and_reject_the_rest():
    ctx = nb(3)
    assert cell_number(ctx, 2) == 2 and cell_number(ctx, "2") == 2 and cell_number(ctx, "c3") == 3
    assert cell_number(ctx, 0) is None and cell_number(ctx, 4) is None and cell_number(ctx, "zzz") is None and cell_number(ctx, None) is None


def test_small_notebooks_are_shown_whole():
    t = build_context_text(nb(3, "c2"), 20000)
    assert "Selected cell: [2]" in t and "x = 1" in t and "x = 3" in t and "not shown" not in t


def test_failed_and_selected_cells_keep_detail_when_space_is_short():
    ctx = nb(60, "c30", big=True)
    ctx.cells[9].failed = True
    t = build_context_text(ctx, 14000)
    assert len(t) <= 14000
    assert "[30]" in t and "[10]" in t and "FAILED" in t


def test_what_does_not_fit_is_announced():
    t = build_context_text(nb(200, "c100", big=True), 6000)
    assert len(t) <= 6000 and "[100]" in t and "more cells are not shown" in t


def test_empty_notebook():
    assert "no cells" in build_context_text(NotebookContext(path="a.ipynb"), 1000)


def test_clip_marks_the_cut():
    assert clip("abc", 10) == "abc" and clip("a" * 50, 20).endswith("…[cut]") and len(clip("a" * 50, 20)) == 20


def test_the_prompt_is_fitted_to_the_window_history_first():
    hist = [{"role": "user", "content": "h" * 3000} for _ in range(10)]
    ctx_text, h, trimmed = _fit("S" * 2000, "n" * 20000, hist, "q" * 500, 8192, 3000)
    assert trimmed and len(h) < 10
    assert 2000 + 500 + 3000 + len(ctx_text) + sum(len(m["content"]) for m in h) < 8192 * 3.2
