# live-streaming-ingest-advanced-simulation
This project (script) allows you to simutale a noisy live streaming contibuition inside your laptop / workstation visualizing the problems in real time.

Thanks to [Jon Carlos Rivera](https://github.com/imbcmdth) for all FEC decoder implementation and ffmpeg FEC patch.

Note: FEC simulation is only available inside Brightcove organization.

## Introduction
This script uses the docker image [jcenzano/docker-ffmpeg](https://hub.docker.com/r/jcenzano/docker-ffmpeg/) to stream a file (simulating a live stream) using one of those protocols (**UDP, RTMP, SRT, TS+FEC**) to a destination, in this case another docker container.
It also allows you to introduce any kind of network problems (packet loss, delay, corruption, reordering, duplication, rate limiting) to the live stream and visually see the results.

### Block diagram simple usage (only: udp, rtmp)
![Block diagram simple](./pics/live-ingest-blocks-simple.png "Block diagram simple")


### Block diagram for udp, rtmp, and srt
![Block diagram](./pics/live-ingest-blocks.png "Block diagram")

### Block diagram for fec
![Block diagram for FEC](./pics/live-ingest-fec-blocks.png "Block diagram for FEC")

Note: **To test FEC (SMPTE 2022) you need to be part of Brightcove organization.**

This code has been really useful to me to test different ingest protocols and tune their configurations.

It is also useful for training purposes, I think it is very handy to see how each protocol react to different network problems.

Another interesting usage that I found is to simulate real ingest links. For instance you could:
1. Get BW, RTT, Jitter, Loses for any link using [iperf](https://github.com/esnet/iperf) and ping (*)
2. Set those params to the simulation
3. Visualize how your ingest link will perform with those network conditions
4. Adjust your protocol settings to fix those problems

(*) Be careful internet conditions changes over time.

Going deeper in the implementation we can say that the media file is NOT transcoded, it is just real time transmuxed to one of the following formats based on the selected protocol:
- RTMP: Format flv
- UDP: Format mpegts
- SRT: Format mpegts
- FEC: Format mpegts over RTP

## Instalation
- Dependencies: [docker](https://www.docker.com/), [NodeJS(V10+)](https://nodejs.org/en/), [ffplay](https://ffmpeg.org/ffplay.html)
- Clone this repo:
```
git clone git@github.com:jordicenzano/live-streaming-ingest-advanced-simulation.git
```

## Usage
For simple simulation execute `./start-simple-simulation.js`
For complex simulation execute `./start-simulation.js`
(Probably first execution will take a while because it will pull the docker container, if you want to speed up that process you could do `docker pull jcenzano/docker-ffmpeg` first)

This is only necessary for FEC simulation (FEC is only available inside Brightcove organization):
```
docker login -u MyUser -p MyPass quay.io

docker pull quay.io/brightcove/docker-fec
docker pull quay.io/brightcove/docker-ffmpeg-fec
```

To see usage instructions you can call the script without arguments:
Simple simulation:
```
Use:
./start-simple-simulation.js PROTOCOL(rtmp, udp, str, fec, or clean) netemCmd TestDuration(s) MediaTestFile DestURL

Example UDP:
./start-simple-simulation.js udp "rate 10mbps loss 5% delay 200ms" 60 /test-video/test.ts "udp://239.1.1.1:2000"

Example RTMP(S):
./start-simple-simulation.js rtmp "rate 10mbps loss 5% delay 200ms" 60 /test-video/test.ts "rtmps://myhost:2000/myStreamKey"
```

Complex simulations:
```
Use:
./start-simulation.js PROTOCOL(rtmp, udp, srt, fec, or clean) netemCmd TestDuration(s) MediaTestFile [ffplayCommand(port2010)] [ProtocolParams]

Example UDP:
./start-simulation.js udp "rate 10mbps loss 5% delay 200ms" 60 /test-video/test.ts "ffplay -x 1280 -y 720 -left 1680 -top 10 tcp://0.0.0.0:2010?listen"

Example RTMP:
./start-simulation.js rtmp "rate 10mbps loss 5% delay 200ms" 60 /test-video/test.ts "ffplay -x 1280 -y 720 -left 1680 -top 10 tcp://0.0.0.0:2010?listen"

Example SRT:
./start-simulation.js srt "rate 10mbps loss 5% delay 200ms" 60 /test-video/test.ts "" latency=200
(In this example you have to manually launch ffplay previously)

Example SRT:
./start-simulation.js srt "rate 10mbps loss 5% delay 200ms" 60 /test-video/test.ts "internal" latency=200

Example FEC:
./start-simulation.js fec "rate 10mbps loss 5% delay 200ms" 60 /test-video/test.ts "internal" "l=8:d=6"

Clean example: start-simulation.js clean (it wil make sure all previous containers are stopped
```

Using netemCmd (netem command) you can specify any kind of network problems such us: rate limiting, packet loss, delay, corruption, duplication, reodering, etc
For more info the about netem command syntax see: http://man7.org/linux/man-pages/man8/tc-netem.8.html

# Misc
You can create a test file following this `ffmpeg` recipe:
```
ffmpeg -y -i in.mp4 -c:v libx264 -maxrate 9000k -bufsize 7000k -x264opts keyint=90:min-keyint=90:scenecut=-1 -b:v 7000k -pass 1 -c:a libfdk_aac -b:a 128k -f mp4 out.mp4
```
Those encoding settings simulates a live stream encoded to 7Mbps with 9Mbps max and 1 keyframe every 90 frames