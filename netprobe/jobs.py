"""轻量后台任务管理: 扫描/追踪等耗时操作通过 job 异步执行与轮询。"""
import threading
import time
import uuid


class JobManager:
    def __init__(self):
        self._jobs = {}
        self._lock = threading.Lock()

    def create(self, jtype, runner, params=None):
        jid = uuid.uuid4().hex[:12]
        job = {
            'id': jid, 'type': jtype, 'status': 'running',
            'params': params or {}, 'progress': {'done': 0, 'total': 0},
            'result': {}, 'error': None, 'cancelled': False,
            'created': time.time(), 'finished': None,
        }
        with self._lock:
            self._gc()
            self._jobs[jid] = job
        threading.Thread(target=self._run, args=(job, runner), daemon=True).start()
        return job

    def cancel(self, jid):
        """请求取消运行中的任务; runner 轮询 cancelled 标志自行收尾。"""
        with self._lock:
            job = self._jobs.get(jid)
            if not job or job['status'] != 'running':
                return False
            job['cancelled'] = True
            return True

    def _run(self, job, runner):
        try:
            runner(job)
            job['status'] = 'cancelled' if job.get('cancelled') else 'done'
        except Exception as e:  # noqa: BLE001 - 任务错误原样回传给前端
            job['error'] = str(e) or repr(e)
            job['status'] = 'error'
        finally:
            job['finished'] = time.time()

    def get(self, jid):
        with self._lock:
            return self._jobs.get(jid)

    def _gc(self):
        now = time.time()
        stale = [k for k, v in self._jobs.items()
                 if v['finished'] and now - v['finished'] > 1800]
        for k in stale:
            del self._jobs[k]
