"""CPU / GPU utilisation sampling."""

import threading
import time

import psutil


class SysMon:
    def __init__(self, interval=1.0):
        self.interval = interval
        self.data = {"cpu": 0.0, "ram": 0.0, "processRamMb": 0.0, "gpu": None}
        self._proc = psutil.Process()
        self._nvml = None
        try:
            import pynvml

            pynvml.nvmlInit()
            self._nvml = pynvml
            self._handle = pynvml.nvmlDeviceGetHandleByIndex(0)
            self._gpu_name = pynvml.nvmlDeviceGetName(self._handle)
            if isinstance(self._gpu_name, bytes):
                self._gpu_name = self._gpu_name.decode()
        except Exception:
            self._nvml = None
        psutil.cpu_percent(None)
        threading.Thread(target=self._loop, daemon=True, name="sysmon").start()

    def _loop(self):
        while True:
            d = {
                "cpu": psutil.cpu_percent(None),
                "ram": psutil.virtual_memory().percent,
                "processRamMb": self._proc.memory_info().rss / 2**20,
                "gpu": None,
            }
            if self._nvml:
                try:
                    u = self._nvml.nvmlDeviceGetUtilizationRates(self._handle)
                    m = self._nvml.nvmlDeviceGetMemoryInfo(self._handle)
                    d["gpu"] = {
                        "name": self._gpu_name,
                        "util": u.gpu,
                        "memUsedMb": m.used / 2**20,
                        "memTotalMb": m.total / 2**20,
                    }
                except Exception:
                    pass
            self.data = d
            time.sleep(self.interval)


def hardware_info():
    info = {"cpu": None, "cores": psutil.cpu_count(logical=False), "threads": psutil.cpu_count(), "ramGb": round(psutil.virtual_memory().total / 2**30, 1)}
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as k:
            info["cpu"] = winreg.QueryValueEx(k, "ProcessorNameString")[0].strip()
    except Exception:
        import platform

        info["cpu"] = platform.processor()
    try:
        import torch

        info["torch"] = torch.__version__
        info["cuda"] = torch.cuda.is_available()
        info["cudaVersion"] = torch.version.cuda
        if torch.cuda.is_available():
            info["gpu"] = torch.cuda.get_device_name(0)
            info["vramGb"] = round(torch.cuda.get_device_properties(0).total_memory / 2**30, 1)
    except Exception as e:
        info["torchError"] = str(e)
    return info
