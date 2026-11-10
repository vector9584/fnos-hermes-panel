import hashlib
import importlib.util
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('panel_usage', ROOT / 'app/server/panel-usage.py')
USAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(USAGE)


class UsageTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.database = Path(self.directory.name) / 'state.db'
        with sqlite3.connect(self.database) as connection:
            connection.executescript('''
                CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT,
                  input_tokens INTEGER, output_tokens INTEGER, api_call_count INTEGER);
                CREATE TABLE messages (session_id TEXT, timestamp REAL, active INTEGER);
                INSERT INTO sessions VALUES ('switch', 'last-model', 150, 30, 3);
                INSERT INTO sessions VALUES ('legacy', 'misleading-last-model', 40, 10, 2);
                INSERT INTO sessions VALUES ('empty', NULL, 0, 0, 0);
                INSERT INTO messages VALUES ('switch', 1704124800, 1);
                INSERT INTO messages VALUES ('switch', 1704124801, 0);
                CREATE TABLE session_model_usage (session_id TEXT, model TEXT,
                  billing_provider TEXT, task TEXT, input_tokens INTEGER,
                  output_tokens INTEGER, api_call_count INTEGER,
                  estimated_cost_usd REAL, actual_cost_usd REAL, cost_status TEXT);
                INSERT INTO session_model_usage VALUES
                  ('switch', 'first-model', 'provider', '', 100, 20, 2, 0.2, 0, 'estimated'),
                  ('switch', 'last-model', 'provider', '', 50, 10, 1, 0.1, 0.08, 'actual'),
                  ('switch', 'vision-model', 'vision-provider', 'vision', 9, 4, 1, 0, 0, NULL);
            ''')

    def test_main_auxiliary_and_legacy_are_counted_once(self):
        before = hashlib.sha256(self.database.read_bytes()).hexdigest()
        result = USAGE.read_usage(self.database)
        self.assertEqual(result['totals']['input_tokens'], 199)
        self.assertEqual(result['totals']['output_tokens'], 44)
        self.assertEqual(result['totals']['api_call_count'], 6)
        self.assertEqual(result['unattributed_tokens'], 50)
        self.assertEqual(result['total_sessions'], 3)
        self.assertEqual(result['total_messages'], 1)
        self.assertEqual(result['activity'][0]['date'], '2024-01-02')
        self.assertAlmostEqual(result['totals']['estimated_cost_usd'], 0.3)
        self.assertEqual(result['totals']['actual_cost_usd'], 0.08)
        self.assertEqual({row['model'] for row in result['by_model']},
                         {'first-model', 'last-model', 'vision-model', None})
        self.assertEqual(hashlib.sha256(self.database.read_bytes()).hexdigest(), before)

    def test_partial_ledger_preserves_unattributed_remainder(self):
        with sqlite3.connect(self.database) as connection:
            connection.execute("DELETE FROM session_model_usage WHERE model='first-model'")
        result = USAGE.read_usage(self.database)
        self.assertEqual(result['totals']['total_tokens'], 243)
        self.assertEqual(result['unattributed_tokens'], 170)

    def test_old_schema_never_borrows_final_session_model(self):
        with sqlite3.connect(self.database) as connection:
            connection.execute('DROP TABLE session_model_usage')
            connection.execute('DROP TABLE messages')
        result = USAGE.read_usage(self.database)
        self.assertEqual(result['totals']['total_tokens'], 230)
        self.assertEqual(result['by_model'][0]['model'], None)
        self.assertIsNone(result['totals']['actual_cost_usd'])
        self.assertEqual(result['activity'], [])

    def test_auxiliary_positive_estimate_is_not_discarded_with_null_status(self):
        with sqlite3.connect(self.database) as connection:
            connection.execute("UPDATE session_model_usage SET estimated_cost_usd=0.05 WHERE task='vision'")
        result = USAGE.read_usage(self.database)
        self.assertAlmostEqual(result['totals']['estimated_cost_usd'], 0.35)
        self.assertEqual(result['coverage']['priced_rows'], 3)
        self.assertEqual(result['coverage']['billed_rows'], 1)
        self.assertEqual(result['coverage']['auxiliary_rows'], 1)

    def test_missing_price_is_not_free_and_missing_route_is_separate_from_history(self):
        with sqlite3.connect(self.database) as connection:
            connection.execute("UPDATE session_model_usage SET model='unknown' WHERE task='vision'")
        result = USAGE.read_usage(self.database)
        self.assertEqual(result['coverage']['historical_tokens'], 50)
        self.assertEqual(result['coverage']['ledger_unattributed_tokens'], 13)
        self.assertEqual(result['coverage']['unpriced_rows'], 1)
        self.assertIsNone(next(row for row in result['by_model'] if row['task']=='vision')['estimated_cost_usd'])

    def test_statistics_never_read_session_prompt_or_message_body(self):
        with sqlite3.connect(self.database) as connection:
            connection.execute('ALTER TABLE sessions ADD COLUMN system_prompt TEXT')
            connection.execute('ALTER TABLE messages ADD COLUMN content TEXT')
        original = sqlite3.connect
        def connect(*args, **kwargs):
            conn = original(*args, **kwargs)
            def authorize(action, arg1, arg2, database, source):
                if action == sqlite3.SQLITE_READ and arg2 in ('system_prompt', 'content'):
                    return sqlite3.SQLITE_DENY
                return sqlite3.SQLITE_OK
            conn.set_authorizer(authorize)
            return conn
        with patch.object(USAGE.sqlite3, 'connect', side_effect=connect):
            self.assertEqual(USAGE.read_usage(self.database)['totals']['total_tokens'], 243)

    def test_missing_database_is_not_created(self):
        missing = self.database.parent / 'missing.db'
        with self.assertRaises(sqlite3.OperationalError):
            USAGE.read_usage(missing)
        self.assertFalse(missing.exists())

    def test_invalid_database_fails_instead_of_reporting_zero(self):
        self.database.write_bytes(b'corrupt')
        with self.assertRaises(sqlite3.DatabaseError):
            USAGE.read_usage(self.database)
        self.assertEqual(self.database.read_bytes(), b'corrupt')


if __name__ == '__main__':
    unittest.main()
