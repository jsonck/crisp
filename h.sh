#!/bin/bash

# to run:
# sh h.sh -m 'commit msg'

MESSAGE=""
SPACER="\n"
BREAKER="\n------------------------------------------------------------------"

while getopts m:c: option
do
        case "${option}"
        in
                m) MESSAGE=${OPTARG};;
                c) COMMITONLY=${OPTARG};;
        esac
done

if [ -z "$MESSAGE" ]; then
    echo "Error: MESSAGE variable is blank. Please provide a commit message."
    exit 1
fi

echo "$SPACER""COMMITING NEW CHANGES""$BREAKER";
git add .; git commit -m "$MESSAGE";

if [ "$COMMITONLY" != true ]; then
  echo "$SPACER""DEPLOYING TO GITHUB ""$BREAKER";
  git push origin main
fi
