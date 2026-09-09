/* Windows counterpart of guard.c: same fd3 protocol, UTF-16 paths/arguments.
 * Lock byte [0,1) with LockFileEx; a kill-on-close Job Object owns all children.
 * The child starts suspended and joins the job before executing any code.
 */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include <string.h>

static HANDLE input_event;
static volatile LONG start_requested, cancel_requested, release_requested, parent_gone;
static int fail(const char *operation) {
    fprintf(stderr, "%s: Windows error %lu\n", operation, GetLastError()); return 2;
}
static int protocol(const char *text) {
    DWORD written = 0; DWORD length = (DWORD)strlen(text);
    return WriteFile((HANDLE)_get_osfhandle(3), text, length, &written, NULL) && written == length;
}
static DWORD WINAPI read_input(LPVOID unused) {
    (void)unused;
    for (;;) {
        char command; DWORD length = 0;
        if (!ReadFile((HANDLE)_get_osfhandle(0), &command, 1, &length, NULL) || length == 0) {
            InterlockedExchange(&parent_gone, 1); SetEvent(input_event); return 0;
        }
        if (command == 'G') InterlockedExchange(&start_requested, 1);
        else if (command == 'C') InterlockedExchange(&cancel_requested, 1);
        else if (command == 'R') InterlockedExchange(&release_requested, 1);
        SetEvent(input_event);
    }
}
static HANDLE acquire(const wchar_t *name, int exclusive) {
    HANDLE handle = CreateFileW(name, GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (handle == INVALID_HANDLE_VALUE) return handle;
    OVERLAPPED region = {0};
    DWORD flags = LOCKFILE_FAIL_IMMEDIATELY | (exclusive ? LOCKFILE_EXCLUSIVE_LOCK : 0);
    if (!LockFileEx(handle, flags, 0, 1, 0, &region)) {
        DWORD error = GetLastError(); CloseHandle(handle); SetLastError(error); return INVALID_HANDLE_VALUE;
    }
    return handle;
}
/* Quote every argument according to the Windows CRT backslash/quote rules.
 * No cmd.exe or PowerShell participates in launching the search command. */
static wchar_t *command_line(int argc, wchar_t **argv) {
    size_t capacity = 1;
    for (int i = 5; i < argc; i++) capacity += 2 * wcslen(argv[i]) + 4;
    if (capacity > 32767) { SetLastError(ERROR_FILENAME_EXCED_RANGE); return NULL; }
    wchar_t *buffer = calloc(capacity, sizeof(wchar_t));
    if (!buffer) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); return NULL; }
    wchar_t *out = buffer;
    for (int i = 5; i < argc; i++) {
        if (i != 5) *out++ = L' ';
        *out++ = L'"';
        const wchar_t *in = argv[i];
        while (*in) {
            size_t slashes = 0;
            while (*in == L'\\') { slashes++; in++; }
            size_t count = (*in == L'"' || *in == 0) ? slashes * 2 : slashes;
            while (count--) *out++ = L'\\';
            if (*in == L'"') *out++ = L'\\';
            if (*in) *out++ = *in++;
        }
        *out++ = L'"';
    }
    *out = 0; return buffer;
}
static int start_child(int argc, wchar_t **argv, HANDLE *job_out, HANDLE *process_out) {
    wchar_t *line = command_line(argc, argv);
    if (!line) return fail("command line");
    wchar_t executable[32768];
    const wchar_t *application = argv[5];
    if (!wcschr(application, L'\\') && !wcschr(application, L'/')) {
        DWORD count = SearchPathW(NULL, application, L".exe", 32768, executable, NULL);
        if (count == 0 || count >= 32768) { free(line); return fail("find executable"); }
        application = executable;
    }
    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (!job) { free(line); return fail("CreateJobObject"); }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        free(line); CloseHandle(job); return fail("SetInformationJobObject");
    }
    SECURITY_ATTRIBUTES security = { sizeof(security), NULL, TRUE };
    HANDLE nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
        &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (nul == INVALID_HANDLE_VALUE) { free(line); CloseHandle(job); return fail("open NUL"); }
    HANDLE inherited[] = { nul, (HANDLE)_get_osfhandle(1), (HANDLE)_get_osfhandle(2) };
    STARTUPINFOEXW startup = {0};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = inherited[0];
    startup.StartupInfo.hStdOutput = inherited[1];
    startup.StartupInfo.hStdError = inherited[2];
    SIZE_T bytes = 0;
    InitializeProcThreadAttributeList(NULL, 1, 0, &bytes);
    startup.lpAttributeList = malloc(bytes);
    BOOL initialized = startup.lpAttributeList && InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes);
    BOOL configured = initialized && UpdateProcThreadAttribute(startup.lpAttributeList, 0,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), NULL, NULL);
    PROCESS_INFORMATION child = {0};
    BOOL created = configured && CreateProcessW(application, line, NULL, NULL, TRUE,
        CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
        NULL, argv[4], &startup.StartupInfo, &child);
    DWORD error = GetLastError();
    if (initialized) DeleteProcThreadAttributeList(startup.lpAttributeList);
    free(startup.lpAttributeList); free(line); CloseHandle(nul);
    if (!created) { CloseHandle(job); SetLastError(error); return fail("CreateProcess"); }
    if (!AssignProcessToJobObject(job, child.hProcess) || ResumeThread(child.hThread) == (DWORD)-1) {
        error = GetLastError(); TerminateProcess(child.hProcess, 126); WaitForSingleObject(child.hProcess, INFINITE);
        CloseHandle(child.hThread); CloseHandle(child.hProcess); CloseHandle(job);
        SetLastError(error); return fail("assign/resume child");
    }
    CloseHandle(child.hThread); *job_out = job; *process_out = child.hProcess; return 0;
}
int wmain(int argc, wchar_t **argv) {
    if (argc < 5 || (wcscmp(argv[1], L"shared") && wcscmp(argv[1], L"exclusive"))) return 2;
    _setmode(1, _O_BINARY); _setmode(2, _O_BINARY); _setmode(3, _O_BINARY);
    /* The control pipe and lock handles must never reach tgrep. */
    SetHandleInformation((HANDLE)_get_osfhandle(0), HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation((HANDLE)_get_osfhandle(3), HANDLE_FLAG_INHERIT, 0);
    const wchar_t *first = argv[2], *second = argv[3];
    if (_wcsicmp(first, second) > 0) { const wchar_t *tmp = first; first = second; second = tmp; }
    int exclusive = !wcscmp(argv[1], L"exclusive");
    HANDLE lock1 = acquire(first, exclusive);
    if (lock1 == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_LOCK_VIOLATION ? 75 : fail("lock");
    HANDLE lock2 = INVALID_HANDLE_VALUE;
    if (_wcsicmp(first, second)) {
        lock2 = acquire(second, exclusive);
        if (lock2 == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_LOCK_VIOLATION ? 75 : fail("external lock");
    }
    input_event = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (!input_event) return fail("CreateEvent");
    HANDLE reader = CreateThread(NULL, 0, read_input, NULL, 0, NULL);
    if (!reader) return fail("CreateThread");
    if (!protocol("READY\n")) return 2;
    HANDLE job = NULL, child = NULL;
    int started = 0, finished = 0, stopping = 0;
    for (;;) {
        WaitForSingleObject(input_event, 20);
        int cancelled = cancel_requested || parent_gone || release_requested;
        if (start_requested && !started && !cancelled) {
            started = 1;
            if (argc == 5) return 2;
            if (start_child(argc, argv, &job, &child)) {
                _close(1); _close(2); finished = 1;
                if (!protocol("EXIT 127\n")) return 2;
            }
        }
        if (child && !finished) {
            if (cancelled && !stopping) { TerminateJobObject(job, 130); stopping = 1; }
            if (WaitForSingleObject(child, 0) == WAIT_OBJECT_0) {
                DWORD code = 0; GetExitCodeProcess(child, &code);
                TerminateJobObject(job, code);
                // Include descendants in the completion boundary before unlock.
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION account;
                do {
                    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &account, sizeof(account), NULL)) return fail("query child job");
                    if (account.ActiveProcesses) Sleep(10);
                } while (account.ActiveProcesses);
                finished = 1; CloseHandle(child); child = NULL; CloseHandle(job); job = NULL;
                _close(1); _close(2);
                char message[64]; snprintf(message, sizeof(message), "EXIT %lu\n", code);
                if (!protocol(message)) return 2;
            }
        }
        if ((parent_gone || release_requested) && (!started || finished)) {
            CloseHandle(lock1); if (lock2 != INVALID_HANDLE_VALUE) CloseHandle(lock2);
            return parent_gone ? 130 : 0;
        }
    }
}
