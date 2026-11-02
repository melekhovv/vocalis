"""Use one disposable data root before importing engine modules in any test order."""
import atexit,os,tempfile
from pathlib import Path
_root=Path(__file__).resolve().parent
_tmp=tempfile.TemporaryDirectory(prefix='engine-tests-',dir=_root)
os.environ['VOCALIS_DATA_DIR']=_tmp.name

def _cleanup():
    os.chdir(_root.parent)
    _tmp.cleanup()

atexit.register(_cleanup)
