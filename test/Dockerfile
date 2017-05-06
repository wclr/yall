# https://github.com/mhart/alpine-node
#FROM mhart/alpine-node:7.1.0
FROM mhart/alpine-node:7.8.0
# RUN apk add --no-cache bash rsync

# install git, we may need git later for installing git deps
# RUN apk add --no-cache git openssh

# yarn
RUN apk update && apk upgrade && apk add --no-cache tar  && \
  apk add --no-cache --virtual .yarn-deps curl gnupg && \
  curl -o- -L https://yarnpkg.com/install.sh | sh && \
  apk del .yarn-deps && \
  apk del tar
# fix yarn link bin creation concurrency
RUN sed -i -e 's/})(), 4);/})(), 1);/g' /root/.yarn/lib/package-linker.js
ENV PATH /root/.yarn/bin:$PATH
RUN yarn config set no-progress true

RUN mkdir /test