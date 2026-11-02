"""Real-time pitch bins must match the offline model's mel-frequency scale."""
import sys,unittest
from pathlib import Path
import numpy as np
import torch
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
import _test_env
from vcengine.paths import prepare_runtime
prepare_runtime()
from rvc.realtime.pipeline import Realtime_Pipeline

class PitchTests(unittest.TestCase):
    def pitch(self,values,shift=0):
        p=Realtime_Pipeline.__new__(Realtime_Pipeline)
        p.f0_method='rmvpe';p.device='cpu';p.dtype=torch.float32
        p.f0_min=50.;p.f0_max=1100.
        p.f0_mel_min=1127*np.log1p(50/700)
        p.f0_mel_max=1127*np.log1p(1100/700)
        p.f0_model=type('PitchModel',(),{'get_f0':lambda self,*a,**kw:torch.tensor(values,dtype=torch.float32)})()
        return p.get_f0(torch.zeros(1600),f0_up_key=shift)

    def test_training_frequency_bounds_map_to_extreme_bins(self):
        coarse,fine=self.pitch([0,50,1100])
        self.assertEqual(coarse.tolist(),[[1,1,255]])
        self.assertEqual(fine.tolist(),[[0.,50.,1100.]])

    def test_bins_match_offline_reference_across_speech_range(self):
        values=np.array([0,40,50,75,100,150,200,300,500,1000,1100,1200],dtype=np.float32)
        lo,hi=1127*np.log1p(np.array([50,1100])/700)
        expected=np.rint(np.clip((1127*np.log1p(values/700)-lo)*254/(hi-lo)+1,1,255)).astype(int)
        coarse,_=self.pitch(values)
        np.testing.assert_array_equal(coarse.numpy()[0],expected)

    def test_transpose_keeps_unvoiced_frames_unvoiced(self):
        _,fine=self.pitch([0,100,200],shift=12)
        torch.testing.assert_close(fine,torch.tensor([[0.,200.,400.]]))

if __name__=='__main__':unittest.main()
