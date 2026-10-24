FROM mcr.microsoft.com/dotnet/sdk:8.0

# procps provides pkill/pgrep, which the judge uses to kill a submission's leftover processes
# between runs. The SDK image does not ship it, so before 2026-10-24 nothing was killed in C#
# containers (JUDGE_FIX_PLAN T2).
RUN apt-get update && apt-get install -y --no-install-recommends procps && rm -rf /var/lib/apt/lists/*

# Create a user 'judge' with a home directory
RUN addgroup --system judge && adduser --system --ingroup judge --home /home/judge judge
RUN mkdir -p /home/judge && chown -R judge:judge /home/judge

# The sandbox root filesystem is read-only and only /tmp and /app are writable. The .NET 8.0.32
# runtime (SDK 8.0.426, pulled 2026-10-24) keeps named-mutex shared memory under the home
# directory from the user database (getpwuid, not $HOME), so with /home/judge every build failed with
# "IOException: The system cannot open the device or file specified. : 'NuGet-Migrations'".
# Point the account and $HOME at /tmp. The warm project below stays at /home/judge/app.
RUN usermod -d /tmp judge

# Pre-create a dotnet project to warm up the cache
WORKDIR /home/judge/app
RUN dotnet new console
RUN dotnet build

ENV HOME=/tmp
ENV DOTNET_CLI_HOME=/tmp
ENV DOTNET_NOLOGO=true
ENV DOTNET_SKIP_FIRST_TIME_EXPERIENCE=true

USER judge
WORKDIR /app
