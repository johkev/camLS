package com.lensmann.camera

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.hardware.camera2.CameraManager
import android.os.Bundle
import android.widget.Toast
import android.view.View
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import android.widget.ArrayAdapter
import com.lensmann.camera.databinding.ActivityMainBinding
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.util.UUID

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private var socket: Socket? = null
    private var cameraStarted = false
    private var peerFactory: PeerConnectionFactory? = null
    private var eglBase: EglBase? = null
    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    private var cameraCapturer: CameraVideoCapturer? = null
    private var videoSource: VideoSource? = null
    private var audioSource: AudioSource? = null
    private var videoTrack: VideoTrack? = null
    private var audioTrack: AudioTrack? = null
    private var activeCameraName: String? = null
    private val deviceKey by lazy {
        getPreferences(MODE_PRIVATE).getString("device_key", null) ?: UUID.randomUUID().toString().also {
            getPreferences(MODE_PRIVATE).edit().putString("device_key", it).apply()
        }
    }
    private var selectedQuality = StreamQuality.BALANCED
    private var ownCameraId: String? = null
    private var remoteCameraSocketId: String? = null
    private var remotePeerConnection: PeerConnection? = null
    private val onlineCameraIds = mutableListOf<String>()
    private val onlineCameraNames = mutableListOf<String>()
    private val peerConnections = mutableMapOf<String, PeerConnection>()

    private val requestPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        val cameraGranted = hasPermission(Manifest.permission.CAMERA)
        val audioGranted = hasPermission(Manifest.permission.RECORD_AUDIO)

        if (cameraGranted && audioGranted) {
            startCameraService()
            startCameraPreview()
            connectToBackend()
        } else {
            setStatus("Kamera- og mikrofon-tillatelser må godkjennes.")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.startCameraButton.setOnClickListener {
            requestRequiredPermissions()
        }

        binding.connectButton.setOnClickListener {
            connectToBackend()
        }

        binding.cameraFacingSpinner.adapter = ArrayAdapter(
            this,
            android.R.layout.simple_spinner_dropdown_item,
            listOf("Bakre kamera", "Foran kamera"),
        )
        binding.qualitySpinner.adapter = ArrayAdapter(
            this,
            android.R.layout.simple_spinner_dropdown_item,
            StreamQuality.values().map { it.label },
        )
        binding.qualitySpinner.setSelection(StreamQuality.BALANCED.ordinal)
        binding.qualitySpinner.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: android.view.View?, position: Int, id: Long) {
                selectedQuality = StreamQuality.values()[position]
            }

            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
        }
        binding.otherCameraSpinner.adapter = ArrayAdapter(
            this,
            android.R.layout.simple_spinner_dropdown_item,
            onlineCameraNames,
        )
        binding.watchOtherCameraButton.setOnClickListener {
            joinSelectedCamera()
        }

        binding.serverSettingsButton.setOnClickListener {
            binding.backendUrlInput.visibility = if (binding.backendUrlInput.visibility == View.VISIBLE) {
                View.GONE
            } else {
                View.VISIBLE
            }
        }

        setStatus("Klar til kamera")
    }

    private fun requestRequiredPermissions() {
        val requiredPermissions = arrayOf(
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO
        )

        val missing = requiredPermissions.filter {
            !hasPermission(it)
        }.toTypedArray()

        if (missing.isEmpty()) {
            startCameraService()
            startCameraPreview()
            connectToBackend()
            return
        }

        requestPermissionLauncher.launch(missing)
    }

    private fun hasPermission(permission: String): Boolean {
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
    }

    private fun startCameraPreview() {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)

        cameraProviderFuture.addListener({
            val cameraProvider = cameraProviderFuture.get()
            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(binding.previewView.surfaceProvider)
            }

            val selectedCamera = if (binding.cameraFacingSpinner.selectedItemPosition == 0) {
                CameraSelector.DEFAULT_BACK_CAMERA
            } else {
                CameraSelector.DEFAULT_FRONT_CAMERA
            }

            try {
                cameraProvider.unbindAll()
                cameraProvider.bindToLifecycle(this, selectedCamera, preview)
                cameraStarted = true
                setStatus("Kamera forhåndsvisning aktiv")
            } catch (exception: Exception) {
                setStatus("Kunne ikke starte kamera: ${exception.message}")
                Toast.makeText(this, "Kunne ikke starte kamera", Toast.LENGTH_LONG).show()
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun connectToBackend() {
        if (socket?.connected() == true) {
            return
        }

        val backendUrl = binding.backendUrlInput.text.toString().trim().ifBlank {
            "http://10.0.2.2:3001"
        }
        val options = IO.Options().apply {
            transports = arrayOf("polling", "websocket")
            forceNew = true
            reconnection = true
            reconnectionAttempts = Int.MAX_VALUE
            reconnectionDelay = 1000
            reconnectionDelayMax = 30000
        }

        socket = IO.socket(backendUrl, options)
        socket?.on(Socket.EVENT_CONNECT) {
            setStatus("Koblet til backend - registrerer kamera")
            val payload = JSONObject().apply {
                put("name", binding.cameraNameInput.text.toString().trim().ifBlank { "Android kamera" })
                put("type", "android")
                put("deviceKey", deviceKey)
            }
            socket?.emit("camera:register", payload)
        }

        socket?.on(Socket.EVENT_DISCONNECT) {
            setStatus("Tilkoblingen brøt - prøver å koble til igjen")
        }

        socket?.on("server:hello") { args ->
            val payload = args.firstOrNull() as? JSONObject
            val message = payload?.optString("message") ?: "Backend tilgjengelig"
            setStatus(message)
        }

        socket?.on("camera:list") { args ->
            val cameras = args.firstOrNull() as? JSONArray ?: return@on
            val cameraEntries = buildList {
                for (index in 0 until cameras.length()) {
                    val camera = cameras.optJSONObject(index) ?: continue
                    val id = camera.optString("id")
                    if (id.isNotBlank() && id != ownCameraId) {
                        add(id to "${camera.optString("name", "Kamera")} (${camera.optString("status", "online")})")
                    }
                }
            }
            runOnUiThread {
                onlineCameraIds.clear()
                onlineCameraNames.clear()
                cameraEntries.forEach { (id, name) ->
                    onlineCameraIds.add(id)
                    onlineCameraNames.add(name)
                }
                (binding.otherCameraSpinner.adapter as? ArrayAdapter<*>)?.notifyDataSetChanged()
                binding.otherCamerasText.text = if (cameraEntries.isEmpty()) {
                    "Andre kameraer: ingen tilkoblet"
                } else {
                    "Andre kameraer: ${cameraEntries.size} online"
                }
            }
        }

        socket?.on("camera:registered") { args ->
            val payload = args.firstOrNull() as? JSONObject
            val cameraId = payload?.optJSONObject("camera")?.optString("id") ?: "ukjent"
            val shareUrl = payload?.optString("shareUrl") ?: "ukjent"
            runOnUiThread {
                ownCameraId = cameraId
                setStatus("Kamera registrert: $cameraId")
                Toast.makeText(this, "Delingslenke: $shareUrl", Toast.LENGTH_LONG).show()
                socket?.emit("camera:start")
                initializeWebRtc()
                sendCameraStatus()
            }
        }

        socket?.on("viewer:joined") { args ->
            val payload = args.firstOrNull() as? JSONObject ?: return@on
            val viewerId = payload.optString("viewerId")
            if (viewerId.isNotBlank()) {
                createOfferForViewer(viewerId)
            } else {
                remoteCameraSocketId = payload.optString("cameraSocketId")
            }
        }

        socket?.on("signal:offer") { args ->
            val payload = args.firstOrNull() as? JSONObject ?: return@on
            val from = payload.optString("from")
            val offer = payload.optJSONObject("offer") ?: return@on
            acceptViewerOffer(from, offer)
        }

        socket?.on("signal:answer") { args ->
            val payload = args.firstOrNull() as? JSONObject ?: return@on
            val viewerId = payload.optString("from")
            val answer = payload.optJSONObject("answer") ?: return@on
            val peerConnection = peerConnections[viewerId] ?: remotePeerConnection ?: return@on
            val description = SessionDescription(
                SessionDescription.Type.fromCanonicalForm(answer.optString("type")),
                answer.optString("sdp"),
            )
            peerConnection.setRemoteDescription(SimpleSdpObserver(), description)
        }

        socket?.on("signal:ice-candidate") { args ->
            val payload = args.firstOrNull() as? JSONObject ?: return@on
            val viewerId = payload.optString("from")
            val candidate = payload.optJSONObject("candidate") ?: return@on
            (peerConnections[viewerId] ?: remotePeerConnection)?.addIceCandidate(
                IceCandidate(
                    candidate.optString("sdpMid"),
                    candidate.optInt("sdpMLineIndex"),
                    candidate.optString("candidate"),
                ),
            )
        }

        socket?.on("viewer:leave") { args ->
            val payload = args.firstOrNull() as? JSONObject ?: return@on
            closePeerConnection(payload.optString("viewerId"))
        }

        socket?.on(Socket.EVENT_CONNECT_ERROR) { args ->
            val message = args.firstOrNull()?.toString() ?: "Koble til backend feilet"
            setStatus("Backendfeil: $message")
        }

        socket?.on("camera:error") { args ->
            val message = args.firstOrNull() as? JSONObject
            val errorText = message?.optString("message") ?: "Ukjent feil"
            setStatus(errorText)
        }

        socket?.on("camera:command") { args ->
            val payload = args.firstOrNull() as? JSONObject ?: return@on
            when (payload.optString("command")) {
                "torch" -> setTorch(payload.optBoolean("enabled"))
                "start" -> runOnUiThread { startStreamingSession() }
                "stop" -> runOnUiThread { stopStreamingSession() }
                "remove" -> runOnUiThread {
                    stopStreamingSession()
                    socket?.disconnect()
                    finish()
                }
            }
        }

        socket?.connect()
    }

    private fun startStreamingSession() {
        startCameraService()
        if (cameraCapturer == null) {
            initializeWebRtc()
        }
        socket?.emit("camera:start")
        sendCameraStatus()
    }

    private fun stopStreamingSession() {
        peerConnections.values.forEach { it.close() }
        peerConnections.clear()
        remotePeerConnection?.close()
        remotePeerConnection = null
        cameraCapturer?.stopCapture()
        cameraCapturer?.dispose()
        cameraCapturer = null
        socket?.emit("camera:stop")
        stopService(Intent(this, CameraForegroundService::class.java))
        setStatus("Kamera stoppet")
    }

    private fun sendCameraStatus() {
        val batteryManager = getSystemService(BatteryManager::class.java)
        val batteryLevel = batteryManager?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
        val connectivityManager = getSystemService(ConnectivityManager::class.java)
        val networkType = connectivityManager?.activeNetwork?.let { network ->
            connectivityManager.getNetworkCapabilities(network)?.let { capabilities ->
                when {
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi"
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "Mobildata"
                    else -> "Nettverk"
                }
            }
        } ?: "Frakoblet"

        socket?.emit("camera:update-status", JSONObject().apply {
            put("batteryLevel", batteryLevel)
            put("networkType", networkType)
            put("quality", selectedQuality.label)
        })
    }

    private fun startCameraService() {
        val serviceIntent = Intent(this, CameraForegroundService::class.java)
        ContextCompat.startForegroundService(this, serviceIntent)
    }

    private fun joinSelectedCamera() {
        val cameraId = onlineCameraIds.getOrNull(binding.otherCameraSpinner.selectedItemPosition)
            ?: return
        val socket = socket ?: return
        if (!socket.connected()) {
            setStatus("Koble til backend først")
            return
        }

        if (peerFactory == null) {
            initializeWebRtc()
        }
        remotePeerConnection?.close()
        remotePeerConnection = null
        binding.remoteVideoView.visibility = View.VISIBLE
        socket.emit("viewer:join", JSONObject().apply { put("cameraId", cameraId) })
        setStatus("Kobler til $cameraId")
    }

    private fun acceptViewerOffer(from: String, offer: JSONObject) {
        val factory = peerFactory ?: return
        val socket = socket ?: return
        val cameraSocketId = remoteCameraSocketId ?: from
        val iceServers = listOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
            PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer(),
        )
        val connection = factory.createPeerConnection(
            PeerConnection.RTCConfiguration(iceServers),
            createViewerPeerObserver(cameraSocketId),
        ) ?: return
        remotePeerConnection?.close()
        remotePeerConnection = connection

        val remoteDescription = SessionDescription(
            SessionDescription.Type.fromCanonicalForm(offer.optString("type")),
            offer.optString("sdp"),
        )
        connection.setRemoteDescription(object : SimpleSdpObserver() {
            override fun onSetSuccess() {
                connection.createAnswer(object : SimpleSdpObserver() {
                    override fun onCreateSuccess(answer: SessionDescription) {
                        connection.setLocalDescription(object : SimpleSdpObserver() {
                            override fun onSetSuccess() {
                                socket.emit("signal:answer", JSONObject().apply {
                                    put("to", from)
                                    put("answer", JSONObject().apply {
                                        put("type", answer.type.canonicalForm())
                                        put("sdp", answer.description)
                                    })
                                })
                            }
                        }, answer)
                    }
                }, MediaConstraints())
            }
        }, remoteDescription)
    }

    private fun createViewerPeerObserver(cameraSocketId: String): PeerConnection.Observer {
        return object : PeerConnection.Observer {
            override fun onTrack(transceiver: RtpTransceiver) {
                val track = transceiver.receiver.track()
                if (track is VideoTrack) {
                    runOnUiThread {
                        binding.remoteVideoView.visibility = View.VISIBLE
                        track.addSink(binding.remoteVideoView)
                    }
                }
            }

            override fun onIceCandidate(candidate: IceCandidate) {
                socket?.emit("signal:ice-candidate", JSONObject().apply {
                    put("to", cameraSocketId)
                    put("candidate", JSONObject().apply {
                        put("sdpMid", candidate.sdpMid)
                        put("sdpMLineIndex", candidate.sdpMLineIndex)
                        put("candidate", candidate.sdp)
                    })
                })
            }

            override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit
            override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
            override fun onAddStream(stream: MediaStream) = Unit
            override fun onRemoveStream(stream: MediaStream) = Unit
            override fun onDataChannel(channel: org.webrtc.DataChannel) = Unit
            override fun onRenegotiationNeeded() = Unit
            override fun onAddTrack(receiver: RtpReceiver, mediaStreams: Array<out MediaStream>) = Unit
        }
    }

    private fun setStatus(message: String) {
        runOnUiThread {
            binding.statusText.text = message
        }
    }

    private fun initializeWebRtc() {
        if (peerFactory != null) {
            return
        }

        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(applicationContext).createInitializationOptions(),
        )

        eglBase = EglBase.create()
        binding.remoteVideoView.init(eglBase!!.eglBaseContext, null)
        binding.remoteVideoView.setEnableHardwareScaler(true)
        binding.remoteVideoView.setMirror(false)
        val encoderFactory = DefaultVideoEncoderFactory(eglBase!!.eglBaseContext, true, true)
        val decoderFactory = DefaultVideoDecoderFactory(eglBase!!.eglBaseContext)
        peerFactory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(encoderFactory)
            .setVideoDecoderFactory(decoderFactory)
            .createPeerConnectionFactory()

        val factory = peerFactory ?: return
        videoSource = factory.createVideoSource(false)
        audioSource = factory.createAudioSource(MediaConstraints())
        videoTrack = factory.createVideoTrack("camera-video", videoSource)
        audioTrack = factory.createAudioTrack("camera-audio", audioSource)

        startWebRtcCapture()
    }

    private fun startWebRtcCapture() {
        peerFactory ?: return
        val source = videoSource ?: return
        if (cameraCapturer != null) {
            return
        }

        ProcessCameraProvider.getInstance(this).get().unbindAll()

        val enumerator = Camera2Enumerator(this)
        val wantsFrontCamera = binding.cameraFacingSpinner.selectedItemPosition == 1
        val cameraName = enumerator.deviceNames.firstOrNull { enumerator.isFrontFacing(it) == wantsFrontCamera }
            ?: enumerator.deviceNames.firstOrNull()
            ?: return

        activeCameraName = cameraName
        cameraCapturer = enumerator.createCapturer(cameraName, null)
        surfaceTextureHelper = SurfaceTextureHelper.create(
            "CameraCaptureThread",
            eglBase?.eglBaseContext,
        )
        cameraCapturer?.initialize(
            surfaceTextureHelper,
            applicationContext,
            source.capturerObserver,
        )
        cameraCapturer?.startCapture(selectedQuality.width, selectedQuality.height, selectedQuality.fps)
        videoTrack?.setEnabled(true)
        audioTrack?.setEnabled(binding.microphoneCheckbox.isChecked)
        setStatus("Kamera klar for live-stream")
    }

    private fun setTorch(enabled: Boolean) {
        val cameraName = activeCameraName ?: return
        try {
            val cameraManager = getSystemService(CameraManager::class.java)
            cameraManager?.setTorchMode(cameraName, enabled)
            setStatus(if (enabled) "Lommelykt på" else "Lommelykt av")
        } catch (exception: Exception) {
            setStatus("Lommelykt er ikke tilgjengelig på dette kameraet")
        }
    }

    private fun createOfferForViewer(viewerId: String) {
        val factory = peerFactory ?: return
        val socket = socket ?: return
        closePeerConnection(viewerId)

        val iceServers = listOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
            PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer(),
        )
        val configuration = PeerConnection.RTCConfiguration(iceServers)
        val peerConnection = factory.createPeerConnection(configuration, createPeerObserver(viewerId)) ?: return
        peerConnections[viewerId] = peerConnection

        videoTrack?.let {
            val sender = peerConnection.addTrack(it, listOf("camera-stream"))
            sender?.let { applyVideoQuality(it) }
        }
        audioTrack?.let { peerConnection.addTrack(it, listOf("camera-stream")) }

        peerConnection.createOffer(object : SimpleSdpObserver() {
            override fun onCreateSuccess(description: SessionDescription) {
                peerConnection.setLocalDescription(object : SimpleSdpObserver() {
                    override fun onSetSuccess() {
                        socket.emit("signal:offer", JSONObject().apply {
                            put("to", viewerId)
                            put("offer", JSONObject().apply {
                                put("type", description.type.canonicalForm())
                                put("sdp", description.description)
                            })
                        })
                    }
                }, description)
            }
        }, MediaConstraints())
    }

    private fun createPeerObserver(viewerId: String): PeerConnection.Observer {
        return object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate) {
                socket?.emit("signal:ice-candidate", JSONObject().apply {
                    put("to", viewerId)
                    put("candidate", JSONObject().apply {
                        put("sdpMid", candidate.sdpMid)
                        put("sdpMLineIndex", candidate.sdpMLineIndex)
                        put("candidate", candidate.sdp)
                    })
                })
            }

            override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit
            override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
            override fun onAddStream(stream: MediaStream) = Unit
            override fun onRemoveStream(stream: MediaStream) = Unit
            override fun onDataChannel(channel: org.webrtc.DataChannel) = Unit
            override fun onRenegotiationNeeded() = Unit
            override fun onAddTrack(receiver: RtpReceiver, mediaStreams: Array<out MediaStream>) = Unit
            override fun onTrack(transceiver: RtpTransceiver) = Unit
        }
    }

    private fun applyVideoQuality(sender: org.webrtc.RtpSender) {
        val parameters = sender.parameters
        parameters.encodings.forEach { encoding ->
            encoding.maxBitrateBps = selectedQuality.bitrateKbps * 1000
            encoding.maxFramerate = selectedQuality.fps
        }
        sender.parameters = parameters
    }

    private fun closePeerConnection(viewerId: String) {
        peerConnections.remove(viewerId)?.close()
    }

    override fun onDestroy() {
        binding.remoteVideoView.release()
        remotePeerConnection?.close()
        peerConnections.values.forEach { it.close() }
        peerConnections.clear()
        cameraCapturer?.stopCapture()
        cameraCapturer?.dispose()
        surfaceTextureHelper?.dispose()
        videoSource?.dispose()
        audioSource?.dispose()
        peerFactory?.dispose()
        eglBase?.release()
        socket?.disconnect()
        super.onDestroy()
    }
}

private enum class StreamQuality(
    val label: String,
    val width: Int,
    val height: Int,
    val fps: Int,
    val bitrateKbps: Int,
) {
    LOW("Lav - 640p / minst lagg", 640, 360, 15, 700),
    BALANCED("Balansert - 720p", 1280, 720, 24, 1800),
    HIGH("Høy - 1080p / best kvalitet", 1920, 1080, 30, 3500),
}

private open class SimpleSdpObserver : SdpObserver {
    override fun onCreateSuccess(description: SessionDescription) = Unit
    override fun onSetSuccess() = Unit
    override fun onCreateFailure(error: String) = Unit
    override fun onSetFailure(error: String) = Unit
}
