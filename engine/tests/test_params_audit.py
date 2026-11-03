import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import _test_env
from vcengine.audio import AudioEngine
class ParamsAuditTests(unittest.TestCase):
    def engine(self):return AudioEngine(type('Models',(),{'list_voices':lambda s:[]})())
    def test_rejected_patch_is_atomic(self):
        e=self.engine();before=dict(e.params)
        with self.assertRaises(ValueError):e.update_params({'pitch':8,'protect':float('nan')})
        self.assertEqual(e.params,before)
    def test_bounds_and_unknown_methods(self):
        for patch in [{'index_rate':2},{'pitch':25},{'f0_method':'unknown'},{'monitor':1},{'ptt_vk':2.5}]:
            with self.subTest(patch=patch):
                with self.assertRaises(ValueError):self.engine().update_params(patch)
    def test_unknown_fields_rejected(self):
        with self.assertRaises(ValueError):self.engine().update_params({'secret':1})
    def test_valid_patch_remains_supported(self):
        e=self.engine();e.update_params({'pitch':-3,'protect':.33,'noise_gate_db':-71})
        self.assertEqual(e.params['pitch'],-3)
