"""Own one disposable Linux network namespace. Never operate on the host netns."""
import argparse
import json
import os
from pathlib import Path
import pwd
import signal
import subprocess
import sys
import time
sys.dont_write_bytecode = True
from tcp_capture import TcpCapture

parser = argparse.ArgumentParser()
parser.add_argument('--node', required=True)
parser.add_argument('--user', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--hz', choices=['60', '30'], required=True)
parser.add_argument('--profile', choices=['rtt0', 'rtt50', 'rtt100', 'rtt150', 'jitter', 'loss', 'interruption', 'slow', 'backlog'], required=True)
parser.add_argument('--topology', choices=['loopback', 'ingress'], default='loopback')
parser.add_argument('--seed', type=int, default=4207)
parser.add_argument('--trace', choices=['none', 'tcp', 'tcp-loopback'], default='none')
parser.add_argument('--tcp-tuning', choices=['none', 'baseline', 'server-rto100', 'client-ack10'], default='none')
args = parser.parse_args()
assert 0 <= args.seed <= 0xffffffff
if args.tcp_tuning != 'none' and (args.hz != '30' or args.profile != 'interruption' or args.topology != 'ingress' or args.trace != 'tcp'):
    parser.error('Socket tuning requires 30Hz ingress interruption with TCP tracing')
if args.trace == 'tcp' and (args.topology != 'ingress' or args.profile not in ['rtt0', 'loss', 'interruption']):
    parser.error('TCP attribution requires ingress rtt0/loss/interruption')
if args.trace == 'tcp-loopback' and (args.topology != 'loopback' or args.hz != '60' or args.profile != 'interruption' or args.tcp_tuning != 'none'):
    parser.error('Loopback diagnosis requires 60Hz interruption and no tuning')
diagnostic = args.trace == 'tcp-loopback'
if args.profile == 'backlog' and args.hz != '60': parser.error('The shared backlog branch is measured at 60 Hz; use slow for 30 Hz')
assert os.geteuid() == 0, 'Only namespace setup needs Linux root'
assert os.readlink('/proc/self/ns/net') != os.readlink('/proc/1/ns/net'), 'Refusing host network namespace'
user = pwd.getpwnam(args.user)
assert user.pw_uid != 0, 'Application must run as an ordinary user'
out = Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=True)
assert not (out / 'ready.json').exists(), 'Choose a fresh output directory; preserve prior evidence'
os.chown(out, user.pw_uid, user.pw_gid)

def command(*parts):
    return subprocess.check_output(parts, text=True, timeout=5)


def timed_command(label, *parts):
    if not diagnostic:
        return command(*parts)
    start = time.monotonic() * 1000
    result = command(*parts)
    end = time.monotonic() * 1000
    assert len(report['commandTimings']) < 100
    report['commandTimings'].append({'label': label, 'startMonotonicMs': start,
                                     'endMonotonicMs': end, 'durationMs': end - start})
    return result
def tcp():
    lines = Path('/proc/net/snmp').read_text().splitlines()
    for i, line in enumerate(lines):
        if line.startswith('Tcp:'):
            return dict(zip(line.split()[1:], map(int, lines[i + 1].split()[1:])))
    raise RuntimeError('TCP statistics unavailable')

def tcp_ext():
    lines = Path('/proc/net/netstat').read_text().splitlines()
    for i, line in enumerate(lines):
        if line.startswith('TcpExt:'):
            return dict(zip(line.split()[1:], map(int, lines[i + 1].split()[1:])))
    raise RuntimeError('TCP extended statistics unavailable')

device = 'ifb-wan' if args.topology == 'ingress' else 'lo'

def configure(options, label=None):
    parts = ('tc', 'qdisc', 'replace', 'dev', device, 'parent', '1:1', 'handle', '10:', 'netem', 'limit', '1000', *options, 'seed', str(args.seed))
    return timed_command(label, *parts) if label else command(*parts)

command('ip', 'link', 'set', 'lo', 'up')
if args.topology == 'ingress':
    command('ip', 'link', 'set', 'lo', 'mtu', '1500')
    command('ip', 'link', 'add', device, 'type', 'ifb')
    command('ip', 'link', 'set', device, 'mtu', '1500')
    command('ip', 'link', 'set', device, 'up')
    for interface in ['lo', device]:
        command('ethtool', '-K', interface, 'gro', 'off', 'gso', 'off', 'tso', 'off')
    command('tc', 'qdisc', 'add', 'dev', 'lo', 'handle', 'ffff:', 'ingress')
    for priority, direction in [(1, 'sport'), (2, 'dport')]:
        command('tc', 'filter', 'add', 'dev', 'lo', 'parent', 'ffff:', 'protocol', 'ip', 'prio', str(priority), 'u32', 'match', 'ip', direction, '45931', '0xffff', 'action', 'mirred', 'egress', 'redirect', 'dev', device)
command('tc', 'qdisc', 'add', 'dev', device, 'root', 'handle', '1:', 'prio', 'bands', '3', 'priomap', *(['2'] * 16))
configure([])
for priority, direction in [(1, 'sport'), (2, 'dport')]:
    command('tc', 'filter', 'add', 'dev', device, 'parent', '1:', 'protocol', 'ip', 'prio', str(priority), 'u32', 'match', 'ip', direction, '45931', '0xffff', 'flowid', '1:1')

delay = {'rtt0': 0, 'rtt50': 25, 'rtt100': 50, 'rtt150': 75, 'jitter': 50, 'loss': 50, 'interruption': 0, 'slow': 0, 'backlog': 0}[args.profile]
options = ['delay', str(delay) + 'ms'] if delay else []
if args.profile == 'jitter': options += ['15ms', 'distribution', 'normal']
if args.profile == 'loss': options += ['loss', 'random', '1%']
if args.profile in ['slow', 'backlog']: options += ['rate', '64kbit']
report = {'namespace': os.readlink('/proc/self/ns/net'), 'hostNamespace': os.readlink('/proc/1/ns/net'), 'applicationUid': user.pw_uid, 'profile': args.profile, 'hz': int(args.hz), 'direction': 'both directions for TCP source/destination port 45931; healthy port 45932 unmodified', 'options': options, 'tcVersion': command('tc', '-V').strip(), 'transitions': []}
report.update({'topology': args.topology, 'seed': args.seed, 'device': device, 'links': json.loads(command('ip', '-j', 'link', 'show')), 'offload': {interface: command('ethtool', '-k', interface) for interface in ['lo', device] if args.topology == 'ingress'}, 'tcpQueues': []})
report['commandTimings'] = []
report['tcpConfig'] = {name: Path('/proc/sys/net/ipv4/' + name).read_text().strip() for name in ['tcp_congestion_control', 'tcp_recovery', 'tcp_sack', 'tcp_timestamps']}
before = tcp()
before_ext = tcp_ext()
capture = TcpCapture(allow_loopback_gso=diagnostic) if args.trace != 'none' else None
script = Path(__file__).with_name('network.mjs').resolve()
application_env = os.environ.copy()
application_env.update({'HARBOR_S3_TEST_NETNS': report['namespace'], 'HARBOR_S3_HOST_NETNS': report['hostNamespace']})
child = subprocess.Popen([args.node, str(script), '--hz=' + args.hz, '--profile=' + args.profile, '--out=' + str(out), '--topology=' + args.topology, '--seed=' + str(args.seed), '--trace=' + args.trace, '--tcp-tuning=' + args.tcp_tuning], env=application_env, user=user.pw_uid, group=user.pw_gid, extra_groups=[], start_new_session=True)
deadline = time.monotonic() + 30
configured = False
blackout = False
recovered = False
sample_started = None
last_queue = 0
try:
    while child.poll() is None:
        if time.monotonic() > deadline: raise TimeoutError('Network scenario exceeded 30 seconds')
        if not configured and (out / 'ready.json').exists():
            configure(options)
            report['initialQdisc'] = json.loads(command('tc', '-j', '-s', 'qdisc', 'show', 'dev', device))
            (out / 'network-ready.json').write_text('{}')
            configured = True
        sample = out / 'sampling.json'
        if sample.exists():
            if sample_started is None:
                sample_started = json.loads(sample.read_text())['monotonicMs']
            elapsed = time.monotonic() * 1000 - sample_started
            if args.profile == 'interruption' and elapsed >= 2000 and not blackout:
                configure(['loss', '100%'], 'blackout-configure')
                report['transitions'].append({'atMs': elapsed, 'appliedAtMs': time.monotonic() * 1000 - sample_started, 'loss': 100})
                blackout = True
            if args.profile == 'interruption' and elapsed >= 2900 and blackout and not recovered:
                configure(options, 'restore-configure')
                report['transitions'].append({'atMs': elapsed, 'appliedAtMs': time.monotonic() * 1000 - sample_started, 'loss': 0})
                recovered = True
            # Retain actual drop evidence well before recovery. If scheduling
            # misses this window, restore first; never delay it for statistics.
            if args.profile == 'interruption' and 2300 <= elapsed < 2800 and blackout and not recovered and 'blackoutQdisc' not in report:
                report['blackoutQdisc'] = json.loads(timed_command('during-blackout-qdisc', 'tc', '-j', '-s', 'qdisc', 'show', 'dev', device))
            near_transition = args.profile == 'interruption' and min(abs(elapsed - 2000), abs(elapsed - 2900)) < 100
            if elapsed - last_queue >= 200 and not near_transition:
                assert len(report['tcpQueues']) < 100
                queue = timed_command('tcp-queue-sample', 'ss', '-tinm', '( sport = :45931 or dport = :45931 )')
                report['tcpQueues'].append({'atMs': elapsed, 'text': queue[:16384], 'truncated': len(queue) > 16384})
                last_queue = elapsed
        time.sleep(.001 if sample_started is not None and args.profile == 'interruption' and not recovered else .025)
    if child.returncode: raise RuntimeError('Application experiment failed: ' + str(child.returncode))
    report['passed'] = True
except BaseException as error:
    report['failure'] = repr(error)
    raise
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try: child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=2)
    report['finalQdisc'] = json.loads(command('tc', '-j', '-s', 'qdisc', 'show', 'dev', device))
    report['ingressQdisc'] = json.loads(command('tc', '-j', '-s', 'qdisc', 'show', 'dev', 'lo'))
    after = tcp()
    report['tcpDelta'] = {key: after[key] - value for key, value in before.items() if key in ['RetransSegs', 'InSegs', 'OutSegs']}
    after_ext = tcp_ext()
    report['tcpExtDelta'] = {key: after_ext[key] - value for key, value in before_ext.items() if after_ext[key] != value}
    try:
        if capture:
            report['capture'] = capture.finish(out / 'tcp-headers.json')
    except BaseException as error:
        report['captureFailure'] = repr(error)
        raise
    finally:
        (out / 'kernel.json').write_text(json.dumps(report, indent=2))
    # Exiting unshare destroys all namespace-owned links, qdiscs and sockets.
