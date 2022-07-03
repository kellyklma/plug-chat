// Require the packages we will use:
const http = require("http"),
    fs = require("fs");

const port = 3456;
const file = "chat_client.html";
// Listen for HTTP connections.  This is essentially a miniature static file server that only serves our one file, chat_client.html, on port 3456:
const server = http.createServer(function (req, res) {
    // This callback runs when a new connection is made to our HTTP server.

    fs.readFile(file, function (err, data) {
        // This callback runs when the chat_client.html file has been read from the filesystem.
        if (err) return res.writeHead(500); // Internal server error code
        res.writeHead(200); // Successful request response code
        res.end(data);
    });
});
server.listen(port);

let users = {}; // dictionary of socket.id : { username, room_name }
let rooms = { "general": { owner: "", pass: "", banned: [] }, "other": { owner: "", pass: "", banned: [] } }; // dict of room_name : {socket.id of owner, password, arr of banned/suspended users? }

// Import Socket.IO and pass our HTTP server object to it.
const socketio = require("socket.io")(http, {
    wsEngine: 'ws'
});

// Attach our Socket.IO server to our HTTP server to listen
const io = socketio.listen(server);
io.sockets.on("connection", function (socket) { // io.sockets is equivalent to simply io (both indicate default namespace connected to: / )
    // This callback runs when a new Socket.IO connection is established.
    let currRoom = "general";
    let userSet = false;
    if (!userSet) { io.sockets.to(socket.id).emit("username_prompt"); }

    // LISTEN FOR USERNAME SUBMISSION TO PARTICIPATE IN CHAT SERVER
    socket.on("set_username", function (data) {
        for (let socketID of Object.keys(users)) {
            if (users[socketID].username == data['username']) { return; } // Prevent duplicate username
        }
        users[socket.id] = { username: data['username'], room: currRoom };
        io.sockets.to(socket.id).emit("changed_username", { username: users[socket.id].username });
        userSet = true;
        socket.join(currRoom);
        getRoomUsers();
        showRooms();
        io.sockets.to(socket.id).emit("update_room", { room: currRoom });
        io.sockets.in(currRoom).emit("announce_action", { username: users[socket.id].username, room: currRoom, action: " connected to " });
    })

    // DISPLAY IN CLIENT THE CURRENT USERS IN CURRENT ROOM
    function getRoomUsers() {
        let roomUsers = {}; // dictionary of username : socket.id
        for (let socketID of Object.keys(users)) {
            if (users[socketID].room == currRoom) {
                roomUsers[users[socketID].username] = socketID;
            }
        }
        io.sockets.in(currRoom).emit("display_users", { roomUsers: roomUsers } ); // Updates display of users in room
        if (rooms[currRoom] !== undefined && rooms[currRoom].owner !== "") {
            // Show kick/ban buttons to owner of privately-owned room
            io.sockets.to(rooms[currRoom].owner).emit("add_kickban"); 
        }
    }

    // DISPLAY IN CLIENT THE ROOMS (BUTTONS) A USER MAY JOIN
    function showRooms() {
        io.sockets.emit("init_rooms", { rooms: rooms }); // Display rooms list at client side
    }

    // CREATE AND JOIN NEW ROOM
    socket.on("create_room", function(data) {
        let roomNames = Object.keys(rooms);
        if (roomNames.includes(data['roomName'])) { return; } // Prevents duplicate room name
        io.sockets.to(socket.id).emit("added_room");
        rooms[data['roomName']] = { owner: socket.id, pass: data['password'], banned: [] };
        showRooms(); // Update rooms list at client side
        changeRoom( { room: data['roomName'] } ); // Join new room
    });

    // LISTEN FOR MESSAGES AND DISPLAY AT CLIENT ACCORDING TO SELECTED RECIPIENT
    socket.on('message_to_server', function (data) { // socket.on listens for incoming messages
        
        // This callback runs when the server receives a new message from the client.
        if (data['recipient'] == "everyone") { // socket.emit broadcasts the message to all other users
            io.sockets.in(currRoom).emit("message_to_client", { username: users[socket.id].username, message: data["message"] }); 
        }
        else { // socket.emit broadcasts the message to selected recipient AND self
            io.sockets.to(data['recipient']).emit("message_to_client", { username: users[socket.id].username, message: "(to " + users[data['recipient']].username + ") " + data["message"] }); 
            io.sockets.to(socket.id).emit("message_to_client", { username: users[socket.id].username, message: "(to " + users[data['recipient']].username + ") " + data["message"] });
        }
    });

    // HANDLE USER MOVEMENT (JOINING ROOMS)
    function changeRoom(data) { // Data in the form of { room: roomName }
        socket.leave(currRoom);
        console.log("leaving " + currRoom);
        users[socket.id].room = data['room'];
        if (rooms[currRoom] !== undefined) {
            getRoomUsers(); // Update list of users in former room
            io.sockets.in(currRoom).emit("announce_action", { username: users[socket.id].username, room: currRoom, action: " left " });
        }
        currRoom = data['room'];
        socket.join(currRoom);
        console.log("joining " + currRoom);
        getRoomUsers(); // Update list of users in new room
        io.sockets.to(socket.id).emit("update_room", { room: currRoom }); // Only change room UI of this socket
        io.sockets.in(currRoom).emit("announce_action", { username: users[socket.id].username, room: currRoom, action: " joined " });
    }

    // JOIN DIFFERENT ROOM
    socket.on('join_room', function (data) {
        if (currRoom == data['room']) return;
        if (rooms[data['room']].pass == "") { // Check if password necessary before prompt password
            changeRoom(data);
        }
        else {
            io.sockets.to(socket.id).emit("prompt_password", { room: data['room'] } );
        }
    });

    // VERIFY PASSWORD GUESS TO ENTER PROTECTED ROOM
    socket.on('check_pass', function(data) { // data holds room name and password guess
        if (rooms[data['room']].pass == data['pass']) {
            changeRoom( { room: data['room'] } );
        }
    });

    // KICKED USER JOINS GENERAL
    socket.on('kick_user', function (data) {
        let userID;
        for (let socketID of Object.keys(users)) {
            if (users[socketID].username == data['username']) {
                userID = socketID;
            }
        }
        io.sockets.to(userID).emit('to_general');
    })

    // BANNED USER JOINS GENERAL AND IS BANNED FROM ROOM(S)
    socket.on('ban_user', function (data) {
        let userID;
        for (let socketID of Object.keys(users)) {
            if (users[socketID].username == data['username']) {
                userID = socketID;
            }
        }
        io.sockets.to(userID).emit('to_general');
        // Add username to ban list
        rooms[currRoom].banned.push(data['username']);
        showRooms();
    })

    // DELETE USER AND ROOM, RELOCATE USERS IN DELETED ROOMS, WHEN USER HAS DISCONNECTED
    socket.on('disconnect', () => {
        if (userSet) {
            io.sockets.in(currRoom).emit("announce_action", { username: users[socket.id].username, room: currRoom, action: " disconnected from " });
            console.log(users);

            delete users[socket.id];
            for (let roomName of Object.keys(rooms)) {
                if (rooms[roomName].owner == socket.id) {
                    io.sockets.to(roomName).emit('to_general'); // Change room of everyone in these rooms
                    delete rooms[roomName]; // Delete room owned by the disconnecting user
                }
            }
            if (rooms[currRoom] !== undefined) {
                getRoomUsers();
            }
            showRooms(); // Update list of rooms for all
            console.log(users);
        }
    });

});