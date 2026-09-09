/* POSIX flock and child lifetime supervisor. Protocol uses fd 3, never stdout.
 * argv: shared|exclusive lock1 lock2 cwd [executable args...]
 * stdout/stderr belong to the command. stdin: G=start, C=cancel, R=release.
 * Locks cover validation, command execution AND final validation/receipt.
 * EOF (including Extension Host death) cancels work before releasing locks.
 */
#include <sys/file.h>
#include <sys/wait.h>
#include <poll.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static volatile sig_atomic_t stopping = 0;
static volatile sig_atomic_t signal_stop = 0;
static void stop(int sig) { (void)sig; signal_stop = 1; }
static long long millis(void) {
    struct timespec now; clock_gettime(CLOCK_MONOTONIC, &now);
    return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}
static int fail(const char *operation) {
    dprintf(2, "%s: %s\n", operation, strerror(errno)); return 2;
}
int main(int argc, char **argv) {
    if (argc < 5 || (strcmp(argv[1], "shared") && strcmp(argv[1], "exclusive"))) return 2;
    signal(SIGTERM, stop); signal(SIGINT, stop); signal(SIGPIPE, SIG_IGN);
    int exclusive = !strcmp(argv[1], "exclusive");
    /* Sorted paths and nonblocking locks avoid deadlocks. Never unlink lock files. */
    char *first = argv[2], *second = argv[3];
    if (strcmp(first, second) > 0) { char *tmp = first; first = second; second = tmp; }
    int lock1 = open(first, O_CREAT | O_RDWR | O_CLOEXEC, 0600);
    if (lock1 < 0) return fail("open lock");
    if (flock(lock1, (exclusive ? LOCK_EX : LOCK_SH) | LOCK_NB)) {
        if (errno == EWOULDBLOCK || errno == EAGAIN) return 75;
        return fail("flock");
    }
    int lock2 = -1;
    if (strcmp(first, second)) {
        lock2 = open(second, O_CREAT | O_RDWR | O_CLOEXEC, 0600);
        if (lock2 < 0) return fail("open external lock");
        if (flock(lock2, (exclusive ? LOCK_EX : LOCK_SH) | LOCK_NB)) {
            if (errno == EWOULDBLOCK || errno == EAGAIN) return 75;
            return fail("external flock");
        }
    }
    if (dprintf(3, "READY\n") < 0) return 2;
    pid_t child = -1;
    int running = 0, started = 0, cancelled = 0, closed = 0, exited = 0;
    long long deadline = 0;
    for (;;) {
        struct pollfd input = { .fd = 0, .events = POLLIN };
        int polled = poll(&input, 1, 20);
        if (signal_stop) { closed = 1; stopping = 1; }
        if (polled < 0 && errno != EINTR) stopping = 1;
        if (polled > 0 && (input.revents & (POLLIN | POLLHUP | POLLERR))) {
            char command; ssize_t n = read(0, &command, 1);
            if (n <= 0) { closed = 1; stopping = 1; }
            else if (command == 'C') stopping = 1;
            else if (command == 'R') {
                if (!running) return 0;
                closed = 1; stopping = 1;
            } else if (command == 'G' && !started && !stopping) {
                started = 1;
                if (argc == 5) return 2;
                child = fork();
                if (child < 0) return fail("fork");
                if (child == 0) {
                    setpgid(0, 0);
                    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGPIPE, SIG_DFL);
                    close(lock1); if (lock2 >= 0) close(lock2); close(3); close(0);
                    if (open("/dev/null", O_RDONLY) != 0) _exit(126);
                    if (chdir(argv[4])) { fail("chdir"); _exit(126); }
                    execvp(argv[5], &argv[5]); fail("exec tgrep"); _exit(127);
                }
                setpgid(child, child);
                running = 1;
            }
        }
        if (stopping && !cancelled) {
            cancelled = 1;
            if (running) { kill(-child, SIGTERM); deadline = millis() + 2000; }
            /* Cancellation during host-side validation must not unlock while
             * its asynchronous writes are still pending. Wait for R or EOF. */
        }
        if (running) {
            if (cancelled && millis() >= deadline) kill(-child, SIGKILL);
            int status; pid_t result = waitpid(child, &status, WNOHANG);
            if (result == child) {
                running = 0; exited = 1;
                /* Reap/terminate remaining group members before unlocking. */
                kill(-child, SIGKILL);
                int code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
                close(1); close(2);
                if (dprintf(3, "EXIT %d\n", code) < 0) return 2;
            } else if (result < 0 && errno != EINTR) return fail("waitpid");
        }
        if (closed && !running) return 130;
        /* On cancellation keep the lock until the host consumes stdout and
         * explicitly releases it. On host death, EOF releases after child exit. */
        if (exited) stopping = 0;
    }
}
