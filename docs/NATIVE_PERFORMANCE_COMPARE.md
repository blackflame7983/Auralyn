# ネイティブ性能の比較

同じ明示的な JSON 計画を before / after の sidecar バイナリで交互に実行し、試行ごとの記録と集計を保存します。音声機器や信号、設定、OS 負荷、ビルド条件を揃えたうえで実行してください。プローブを実行する Python に `psutil` が必要です。

```powershell
python scripts/native_performance_compare.py --before C:\path\before\audio_engine.exe --after C:\path\after\audio_engine.exe --plan C:\path\plan.json --output C:\path\new-comparison --repeats 3
```

計画は `native_audio_probe.py` と同じ JSON 配列で、各ステップに `label` を指定します。`command` と `expect`、`wait_seconds`、`measure_seconds` を使用でき、正の有限な `measure_seconds` を持つステップが一つ以上必要です。計測ラベルは一意にしてください。計画の機器指定とコマンドは実行環境に合わせて確認してください。

各版を最低 3 回、AB、BA、AB の順に実行します。出力先は存在しない新しいディレクトリを指定してください。`test-results`、`playwright-report`、`blob-report`、`playwright` 内は指定できません。各試行のディレクトリにプローブの結果と sidecar ログを、比較ディレクトリにプローブ自身の標準出力・標準エラーと `summary.json` を残します。入力パスと SHA-256 を記録し、試行中の変更を検出すると失敗扱いにします。

計測ラベルごとに、有効な試行の CPU 平均、範囲、母標準偏差、最大 private bytes、試行数を記録します。CPU は 1 論理コアを 100% とする sidecar 単体の値です。非計測ステップは集計対象外です。有効な試行がない値は `unavailable`、実行前の状態は `skipped` として区別します。いずれかの試行が失敗、計測窓が不足、サンプルが不正なら全体は失敗し終了コードは非ゼロです。失敗した試行は集計しません。部分集計が残っても比較成功を意味しません。

この計測だけでは実際の配信、音質、音切れ、長時間動作、アプリ全体や別の機器での性能は保証できません。結果は各試行のログ、実行条件、ばらつきと合わせて判断してください。

アプリ全体を測定する場合は、起動済み Host の PID を指定します。Host とその子孫（WebView や engine を含む）の各時点の working set と private bytes を合計し、その観測最大値と CPU 平均を記録します。

```powershell
python scripts/native_audio_probe.py --tree <HOST_PID> 30 C:\path\tree.json
```

約 100 ms 間隔の標本であり、標本間のピークや短命な子は捕捉できません。CPU は 1 論理コアを 100% とし、初回の基準値は平均に含めません。途中で現れた子の初回 CPU は未計測であり、`cpu_unprimed_process_count` に記録します。終了した子は `disappeared_child_count` で区別します。root の終了、アクセス拒否や必須値の欠測は失敗です。指定時間は 0.1 秒以上の有限値が必要です。

`max_working_set_bytes` と `max_private_bytes` は同時点のプロセス合計の観測最大です。`root_lifetime_peak_working_set_bytes` と `root_lifetime_peak_commit_bytes` は root 単体の OS 記録によるプロセス起動以来のピークであり、計測窓や子を含みません。sidecar 比較の `os_peak_working_set_bytes` と `os_peak_commit_bytes` も同様に sidecar 単体の生涯ピークです。commit と private の標本最大は別の値です。各版のアプリを同じ条件で別々に測定し、結果と条件を併記してください。
