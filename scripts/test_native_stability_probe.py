import copy
import unittest
from native_stability_probe import validate_progress


class StabilityAcceptance(unittest.TestCase):
    def setUp(self):
        self.before = {'active_plugin_count': 3, 'enabled_plugin_count': 3, 'latency_metadata': {'streamRunning': True},
                       'queue_diagnostics': {'state': 'running', 'epoch': 'one', 'receivedInputFrames': 10,
                           'requestedOutputFrames': 10, 'consumedOutputFrames': 10, 'zeroFilledOutputFrames': 0, 'droppedOutputFrames': 0}}
        self.after = copy.deepcopy(self.before)
        for key in ['receivedInputFrames', 'requestedOutputFrames', 'consumedOutputFrames']:
            self.after['queue_diagnostics'][key] = 20

    def test_actual_progress_is_accepted(self):
        validate_progress(self.before, self.after, 3)

    def test_stale_stats_are_not_one_hour_of_work(self):
        with self.assertRaises(ValueError):
            validate_progress(self.before, self.before, 3)

    def test_drop_underflow_restart_and_disabled_plugin_are_rejected(self):
        for key, value in [('zeroFilledOutputFrames', 1), ('droppedOutputFrames', 1), ('epoch', 'two'), ('state', 'stopped')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                current = copy.deepcopy(self.after)
                current['queue_diagnostics'][key] = value
                validate_progress(self.before, current, 3)
        self.after['enabled_plugin_count'] = 2
        with self.assertRaises(ValueError):
            validate_progress(self.before, self.after, 3)


if __name__ == '__main__':
    unittest.main()
