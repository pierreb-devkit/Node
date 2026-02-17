## Introduction

Welcome to the Node wiki! Here you will find various information about this repo.

## Menu

#### Node Wiki

* [Api](https://github.com/pierreb-devkit/Node/blob/master/WIKI.md#API)
  * [Success](https://github.com/pierreb-devkit/Node/blob/master/WIKI.md#Success)
  * [Errors](https://github.com/pierreb-devkit/Node/blob/master/WIKI.md#Errors)
  * [Authentification](https://github.com/pierreb-devkit/Node/blob/master/WIKI.md#Authentification)
* [SSL](https://github.com/pierreb-devkit/Node/blob/master/WIKI.md#SSL)



* [Mindset and what we would like to create](https://github.com/pierreb-devkit)
* [Global roadmap and ideas about stacks](https://github.com/orgs/pierreb-devkit/projects)

# Node WIKI

## API

### Success

`responses.success(res, 'task created')({});`

body :

```
{
 type: 'success',
 message: 'task created'
 data: {}
}
```

### Errors

#### default

`responses.error(res, 422, 'Unprocessable Entity', 'task creation failed')({err});`

body :

```
{
 code: 422,
 message: 'Unprocessable Entity'
 description: 'task creation failed'
 type: 'error',
 error: '{err}'
}
```

#### schema

`responses.error(res, 422, 'Unprocessable Entity', errors.getMessage(err))({err});`

body :

```
{
 code: 422,
 message: 'Unprocessable Entity'
 description: 'Title must be a string. Name must be a string.',
 type: 'error',
 error: '{
  original: {
   title: 2,
   description: 'do something about something else'
  },
       details: [{
        message: 'title must be a string',
        type: 'string.base'
       },
       {
        message: 'name must be a string',
        type: 'string.base'
       }]
   }'
}
```

#### service & others

`throw new AppError('invalid user or password.', { code: 'SERVICE_ERROR', details: [] });`

body :

```
{
   type: 'error',
   message: 'invalid user or password.',
   error: {
    code: 'SERVICE_ERROR',
    details: []
   }
}
```

#### authentication

status : 401
error :

```
{
 text: 'Unauthorized'
}
```

### Authentification

As explained in Readme, we are curently using JWT Stateless, the server is unaware of who sends the request, it don’t maintain the state.

#### How to manage authentification

* **First**, you need to signin (or signup) with a post request :

Post : `http://localhost:3000/api/auth/signin`
with json body :

```
{
 "email": "user@localhost.com",
 "password": "F5FSpvRGBvtwQWCQJY2Y"
}
```

The answer will be something like this :

```
{
    "user": {
        "roles": [
            "user"
        ],
        "_id": "5cdfd9a18da698bacb4ca448",
        "provider": "local",
        "email": "user@localhost.com",
        "firstName": "User",
        "lastName": "Local",
        "displayName": "User Local",
        "password": "$2b$10$gmrfSq32PolvXKgAxt8BK.ic/mliTT3FU5/jE85HlJVjbNYlwjoga",
        "__v": 0,
        "id": "5cdfd9a18da698bacb4ca448"
    },
    "tokenExpiresIn": 1558263105423
}
```

with and header set Cookie like this :

```
Set-Cookie →TOKEN=aaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.ccccccc; Path=/; HttpOnly
```

* **Second**, you need to set this cookie for api request, it's ok !

* **third**, You can renew the token before it expires as you wish, thanks to the signin you know the expiration date. You can also check the status of the token regularly, via `/users/me` for example. Or simply redirect the user to the sign once the token has expired.

#### Jwt configuration

Two options are available in `config/default/development.js` for the default and `production.js` if you want to override the default values ​​in produciton.

```
  // jwt is for token authentification
  jwt: {
    secret: 'test', // secret for hash
    expiresIn: 7 * 24 * 60 * 60, // token expire in x sec
  },
```

#### Password configuration

we use the package [zxcvbn](https://github.com/dropbox/zxcvbn) to check package security

```
  // zxcvbn is used to manage password security
  zxcvbn: {
    minimumScore: 3,
  },
```

## SSL

There are two ways to set up https, the most used way is to set up a reverse proxy in front of the server node, and enable let's encrypt.

The second is to set up https directly at the node server.

Both are possible with the stack.

### Reverse Proxy with Let's Encrypt

We recommend this method, however we will not explain it. Many [tutorials](https://www.google.com/search?client=safari&rls=en&ei=ZFqwXNGMB43jgweCnbXgCg&q=node+let%27s+encrypt+nginx&oq=node+let%27s+encrypt+nginx&gs_l=psy-ab.3..0i8i13i30l3.9384.13054..13286...0.0..0.52.1036.24......0....1..gws-wiz.......0i71j0i67j0j0i131j0i22i30j0i13i30j0i13i10i30j0i19j0i13i30i19j0i22i30i19j0i22i10i30i19j0i8i13i30i19.ejqWS4vw2Qs) already exist, and it depends on what you use, [apache](https://httpd.apache.org), [nginx](https://www.nginx.com), [traeffik](https://traefik.io), [Let's Encrypt](https://letsencrypt.org) ...

### Express TLS - SSL

To run your application in a secure manner with express you'll need to use OpenSSL and generate a set of self-signed certificates.

* Unix-based users can use the following command:

 ```bash
 npm run generate-ssl-certs
 ```

this will create cert and key files and place them in *config/sslcerts* folder.

* Windows users can follow instructions found [here](http://www.websense.com/support/article/kbarticle/How-to-use-OpenSSL-and-Microsoft-Certification-Authority).
After you've generated the key and certificate, place them in the *config/sslcerts* folder.

Finally, uncomment and activate ssl in configuration (*config/defaults/development.js*) :

```
// SSL on express server (FYI : Wiki)
secure: {
   ssl: true,
   key: './config/sslcerts/key.pem',
   cert: './config/sslcerts/cert.pem',
},
```
