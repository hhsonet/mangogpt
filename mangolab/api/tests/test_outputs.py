from app.services.outputs import MAX_EXEC_BYTES, OutputList, convert, fold_cr


def stream(name, text):
    return convert("stream", {"name": name, "text": text})


def test_fold_cr_behaves_like_a_terminal():
    assert fold_cr("a\rb") == "b"
    assert fold_cr("hello\rHi") == "Hillo"            # shorter overwrite leaves the tail
    assert fold_cr("x\r\ny") == "x\ny"                 # CRLF is a plain newline
    assert fold_cr("10%\r20%\r30%") == "30%"
    assert fold_cr("line1\nline2\rL") == "line1\nLine2"          # only the last line is rewritten
    assert fold_cr("plain") == "plain"


def test_streams_merge_per_name_and_keep_order():
    o = OutputList()
    for out in (stream("stdout", "a"), stream("stdout", "b\n"), stream("stderr", "e"), stream("stdout", "c")):
        o.add(out)
    assert [(i["name"], i["text"]) for i in o.items] == [("stdout", "ab\n"), ("stderr", "e"), ("stdout", "c")]


def test_progress_bars_do_not_grow_without_bound():
    o = OutputList()
    for i in range(10_000):
        o.add(stream("stderr", f"\r{i:5d}/10000"))
    assert len(o.items) == 1 and o.items[0]["text"].strip() == "9999/10000"


def test_display_update_replaces_in_place_and_reports_its_index():
    o = OutputList()
    o.add(stream("stdout", "x"))
    o.add(convert("display_data", {"data": {"text/plain": "first"}, "metadata": {}}), display_id="d")
    assert o.update_display("d", {"text/plain": "second"}, {}) == 1
    assert o.items[1]["data"]["text/plain"] == "second"
    assert o.update_display("nope", {}, {}) is None


def test_deferred_clear_applies_before_the_next_output():
    o = OutputList()
    o.add(stream("stdout", "old"))
    o.pending_clear = True
    added, cleared = o.add(stream("stdout", "new"))
    assert cleared and added["text"] == "new" and len(o.items) == 1


def test_oversized_single_output_is_replaced_by_a_notice():
    o = OutputList()
    added, _ = o.add(convert("display_data", {"data": {"image/png": "A" * (9 * 1024 * 1024)}, "metadata": {}}))
    assert "too large" in added["data"]["text/plain"]


def test_total_output_is_capped_with_one_notice():
    o = OutputList()
    chunk = "x" * (1024 * 1024)
    for i in range(MAX_EXEC_BYTES // len(chunk) + 8):
        o.add(convert("display_data", {"data": {"text/plain": chunk}, "metadata": {}}))
    assert o.truncated and "truncated" in o.items[-1]["text"]
    before = len(o.items)
    o.add(stream("stdout", "more"))
    assert len(o.items) == before


def test_non_output_messages_are_ignored():
    assert convert("status", {"execution_state": "busy"}) is None
    assert convert("execute_input", {}) is None
