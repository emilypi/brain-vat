#include <sys/resource.h>
#include <stdio.h>
#include <unistd.h>

/* Trusted launcher: limits survive exec and cannot be raised by the proof. */
static int limit(int resource, rlim_t value) {
  struct rlimit bound;
  if (getrlimit(resource, &bound) != 0) return -1;
  if (bound.rlim_max != RLIM_INFINITY && bound.rlim_max < value) {
    value = bound.rlim_max;
  }
  bound.rlim_cur = value;
  bound.rlim_max = value;
  if (setrlimit(resource, &bound) == 0) return 0;
  fprintf(stderr, "Resource limit %d failed: ", resource);
  perror("setrlimit");
  return -1;
}

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  if (limit(RLIMIT_CPU, 45) || limit(RLIMIT_CORE, 0) ||
      limit(RLIMIT_FSIZE, 64 * 1024 * 1024) ||
      limit(RLIMIT_STACK, 64 * 1024 * 1024) || limit(RLIMIT_NOFILE, 128)) {
    fputs("Could not establish process limits.\n", stderr);
    return 2;
  }
  execv(argv[1], argv + 1);
  fputs("Could not start pinned Lean executable.\n", stderr);
  return 2;
}
