import crypto from 'hypercore-crypto'; // Cryptographic functions for generating the key in app
import b4a from 'b4a';                 // Module for buffer-to-string and vice-versa conversions
import {swarm} from './network.js';
import {decodeChunk, encodeChunk} from './video.js';
import {createObservableMap} from './utils.js';

let cameraOn = false; // should be shared across peers
let localVideoStream;  // should be shared across peers chunk by chunk
let remoteUsers = createObservableMap();

// When there's a new connection, listen for new video streams, and add them to the UI
swarm.on('connection', (socket, peerInfo) => {
  const strKey = b4a.toString(socket.remotePublicKey, 'hex');
  console.log(peerInfo);
  // Check if stream exists for this peer
  if (!remoteUsers.has(strKey)) {
    const transformer = new TransformStream({
      transform: (chunk, controller) => {
        controller.enqueue(chunk);
      },
    });
    onPeerJoined(strKey, transformer);
    remoteUsers.set(strKey, transformer);
  }

  socket.on('data', async (chunk) => {
    const transformer = remoteUsers.get(strKey);
    try {
      const writer = transformer.writable.getWriter();
      await writer.write(chunk);
      writer.releaseLock();
    } catch (error) {
      console.error('Error getting writer for peer:', strKey, error);
      // Handle the error (e.g., remove peer or reconnect)
    }
  });

  socket.once('close', async () => {
    const transformer = remoteUsers.get(strKey);
    await closeTransformStream(transformer);
    onPeerLeft(strKey); // Handle UI update on peer leave
  });
});

// When there's updates to the swarm, update the peers count
swarm.on('update', () => {
  document.querySelector('#peers-count').textContent = swarm.connections.size;
});

document.querySelector('#create-chat-room').addEventListener('click', createChatRoom);
document.querySelector('#join-form').addEventListener('submit', joinChatRoom);

async function joinSwarm(topicBuffer) {
  document.querySelector('#setup').classList.add('hidden');
  document.querySelector('#loading').classList.remove('hidden');
  swarm.join(topicBuffer);
  document.querySelector('#chat-room-topic').innerText = b4a.toString(topicBuffer, 'hex');
  document.querySelector('#loading').classList.add('hidden');
  document.querySelector('#chat').classList.remove('hidden');
}


async function leaveSwarm(topicBuffer) {
  // Stop local stream if camera is on
  if (cameraOn) {
    await stopLocalStream();
    cameraOn = false;
  }

  document.querySelector('#setup').classList.remove('hidden');
  document.querySelector('#loading').classList.remove('hidden');
  await swarm.leave(topicBuffer);
  document.querySelector('#chat-room-topic').innerText = '';
  document.querySelector('#loading').classList.add('hidden');
  document.querySelector('#chat').classList.add('hidden');
}

async function createChatRoom() {
  const chanelKeyByte = crypto.randomBytes(32);
  await joinSwarm(chanelKeyByte);
}

async function joinChatRoom(e) {
  e.preventDefault();
  const topicStr = document.querySelector('#join-chat-room-topic').value;
  const topicBuffer = b4a.from(topicStr, 'hex');
  await joinSwarm(topicBuffer);
}

async function leaveChatRoom(e) {
  e?.preventDefault();
  const topicStr = document.querySelector('#join-chat-room-topic').value;
  const topicBuffer = b4a.from(topicStr, 'hex');
  console.log({topicBuffer});
  await leaveSwarm(topicBuffer);
}

document.querySelector('#leave-btn').addEventListener('click', leaveChatRoom);

const cameraButton = document.getElementById('camera-btn');
const videoStreamsContainer = document.getElementById('video-streams');




async function startLocalStream() {
  const stream = await navigator.mediaDevices.getUserMedia({video: true});
  const [videoTrack] = stream.getVideoTracks();

  const mediaProcessor = new MediaStreamTrackProcessor({track: videoTrack});
  const inputStream = mediaProcessor.readable;

  const mediaGenerator = new MediaStreamTrackGenerator({kind: 'video'});
  const outputStream = mediaGenerator.writable;

  const encoderTransformStream = new TransformStream({
    start(controller) {
      this.frameCounter = 0;
      this.keyFrameInterval = 150; // Generate a key frame every 150 frame
      this.encoder = new VideoEncoder({
        output: async (chunk) => {
          const encoded = encodeChunk(chunk);
          // Send the message to all peers (that you are connected to)
          const peers = [...swarm.connections];
          for await (const peer of peers) {
            peer.write(encoded);
          }
          controller.enqueue(encoded);
        },
        error: (error) => {
          console.error('VideoEncoder error:', error);
        },
      });
      const {width, height} = videoTrack.getSettings();

      this.encoder.configure({
        codec: 'vp8',
        width,
        height,
        bitrate: 2_000_000,
        framerate: 30,
      });

    },
    async transform(frame) {
      if (this.encoder.encodeQueueSize > 2) {
        frame.close();
      } else {
        /**
         * In video encoding and streaming, ensuring that peers who join later can correctly decode the video stream
         * requires transmitting key frames periodically and marking them appropriately.
         * Key frames (also known as intra frames) are self-contained frames that can be decoded independently,
         * unlike other frames (inter frames) that rely on previous frames for decoding.
         * */
        const insertKeyFrame = this.frameCounter % this.keyFrameInterval === 0;
        this.encoder.encode(frame, { keyFrame: insertKeyFrame });
        this.frameCounter++;
        frame.close();
      }
    },
    flush() {
      this.encoder.flush();
    },
  });

  const decoderTransformStream = new TransformStream({
    start(controller) {
      this.decoder = new VideoDecoder({
        output: (frame) => {
          controller.enqueue(frame);
        },
        error: (error) => console.error('VideoDecoder error:', error),
      });
      this.decoder.configure({codec: 'vp8'});
    },
    async transform(chunk) {
      const decodedChunk = decodeChunk(chunk);
      this.decoder.decode(decodedChunk);
    },
  });

  inputStream
    .pipeThrough(encoderTransformStream)
    .pipeThrough(decoderTransformStream)
    .pipeTo(outputStream);

  const existingVideo = document.getElementById('local-video');

  localVideoStream = new MediaStream();
  localVideoStream.addTrack(mediaGenerator);

  if (existingVideo) {
    existingVideo.srcObject = new MediaStream([mediaGenerator]);
  } else {
    const video = document.createElement('video');
    video.id = 'local-video';
    video.classList.add('video-container');
    video.style.width = '100%';
    video.style.height = '100%';
    video.autoplay = true;
    video.srcObject = new MediaStream([mediaGenerator]);

    const videoContainer = document.createElement('div');
    videoContainer.classList.add('video-container');
    videoContainer.id = 'user-container-local';

    videoContainer.appendChild(video);
    videoStreamsContainer.appendChild(videoContainer);
  }

  cameraOn = true;
}

async function stopLocalStream() {
  if (localVideoStream) {
    const existingVideo = document.getElementById('local-video');
    existingVideo.pause();
    existingVideo.currentTime = 0; // Reset the video to the beginning
    // Stop all tracks of the MediaStream
    stopMediaTracks(localVideoStream);
    // Clear the srcObject to fully "stop" the video
    existingVideo.srcObject = null;
    cameraOn = false;
  }
}

cameraButton.addEventListener('click', async () => {
  if (cameraOn) {
    await stopLocalStream();
    cameraButton.innerHTML = 'Camera On';
  } else {
    await startLocalStream();
    cameraButton.innerHTML = 'Camera Off';
  }
});


remoteUsers.onAdd((key, value) => {
  console.log(`New item added: ${key} => ${value}`);
  // onPeerJoined(key, value);
});

remoteUsers.onRemove((key) => {
  console.log(`Item deleted: ${key}`);
  const idToRemove = `user-container-${key}`;
  const elementToRemove = document.getElementById(idToRemove);
  elementToRemove.remove();
  // Get the transform stream for the removed peer
  // const transformer = remoteUsers.deleted?.[key];
  // if (transformer) {
  //   // Reader and writer are closed automatically when the TransformStream is garbage collected
  // }
});



function onPeerJoined(key, inputTransform) {
  if (!remoteUsers.get(key)) {
    const decoderTransformStream = new TransformStream({
      start(controller) {
        this.decoder = new VideoDecoder({
          output: (frame) => {
            controller.enqueue(frame);
          },
          error: (error) => console.error('VideoDecoder error:', error),
        });
        this.started = false;
        this.decoder.configure({codec: 'vp8'});
      },
      async transform(chunk, controller) {
        const decoded = decodeChunk(chunk);
        if (decoded instanceof EncodedVideoChunk) {
          /**
           * When a new peer joins, it's important to ensure they receive a key frame to initialize their decoder properly.
           * Decode Key Frames First: Ensure that the key frame is decoded first for new peers.
           * */
          if(decoded.type === 'key') {
            await this.decoder.decode(decoded); // Decode the key frame first
            this.started = true;
          } else if(this.started) {
            await this.decoder.decode(decoded);
          }

        } else if (!controller.closed) {
          controller.enqueue(chunk);
        }
      },
      async flush() {
        // After receiving all chunks, decode any remaining non-key frames

      },
    });
    const remoteInput = inputTransform.readable.pipeThrough(decoderTransformStream);
    const mediaGenerator = new MediaStreamTrackGenerator({kind: 'video'});
    const outputStream = mediaGenerator.writable;
    remoteInput.pipeTo(outputStream);

    const existingVideoElement = document.getElementById(`video-${key}`);
    if (existingVideoElement) {
      existingVideoElement.srcObject = new MediaStream([mediaGenerator]);
    } else {
      const remoteVideo = document.createElement('video');
      remoteVideo.id = `video-${key}`;
      remoteVideo.classList.add('video-container');
      remoteVideo.style.width = '100%';
      remoteVideo.style.height = '100%';
      remoteVideo.autoplay = true;

      remoteVideo.srcObject = new MediaStream([mediaGenerator]);

      const videoContainer = document.createElement('div');
      videoContainer.classList.add('video-container');
      videoContainer.id = `user-container-${key}`;
      videoContainer.appendChild(remoteVideo);
      videoStreamsContainer.appendChild(videoContainer);
    }

  }
}

const stopMediaTracks = stream => {
  stream.getTracks().forEach(track => {
    track.stop();
  });
};

function onPeerLeft(key) {
  console.log(`Peer left: ${key}`);
  remoteUsers.delete(key); // Ensure the peer is removed from the map
  const idToRemove = `user-container-${key}`;
  const elementToRemove = document.getElementById(idToRemove);
  if (elementToRemove) {
    elementToRemove.remove(); // Remove the video element from the DOM
  }
}

// Function to close the transform stream
async function closeTransformStream(transformer) {
  if (transformer.readable.locked) {
    const reader = transformer.readable.getReader();
    await reader.cancel();
    reader.releaseLock();
  }

  if (transformer.writable.locked) {
    const writer = transformer.writable.getWriter();
    await writer.close();
    writer.releaseLock();
  }
}
