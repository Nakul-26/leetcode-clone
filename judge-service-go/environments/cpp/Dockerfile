FROM gcc:latest

# Install nlohmann-json for the C++ wrapper harness
RUN apt-get update \
    && apt-get install -y --no-install-recommends nlohmann-json3-dev \
    && rm -rf /var/lib/apt/lists/*

# Precompiled <bits/stdc++.h> (JUDGE_FIX_PLAN T7), built with the stdin-mode flags (-O2,
# default standard) in the header's own directory, where g++ looks for it. g++ uses it only
# when the flags match and otherwise silently parses the header as usual, so the last step
# fails the build if a test program does not actually use it. Measured 2026-10-24 on one
# core: a typical bits/stdc++.h program compiles in 0.8 s instead of 2.8 s.
RUN H="$(echo '#include <bits/stdc++.h>' | g++ -O2 -x c++ -H -fsyntax-only - 2>&1 | awk '/stdc\+\+\.h$/ {print $2; exit}')" \
    && g++ -O2 -x c++-header "$H" -o "$H.gch" \
    && printf '#include <bits/stdc++.h>\nint main() {}\n' > /tmp/pch-check.cpp \
    && g++ -O2 -H -o /tmp/pch-check /tmp/pch-check.cpp 2>&1 | grep -q '^! .*stdc++.h.gch' \
    && rm -f /tmp/pch-check /tmp/pch-check.cpp

# Create a non-root user 'judge'
RUN addgroup --system judge && adduser --system --ingroup judge judge

# Set the user
USER judge
