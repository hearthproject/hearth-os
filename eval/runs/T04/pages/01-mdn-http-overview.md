<!-- ARCHIVE-PROVENANCE: source metadata below; body is a verbatim local snapshot. -->

**归档状态：成功。** 正文来自只读快照，未联网；缺失信息以“未知/待确认”标注。

| 归档字段 | 值 |
| --- | --- |
| 原始 URL | [打开原始 URL](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Overview) |
| 最终 URL | [打开最终 URL](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Overview) |
| 抓取时间 | `2026-11-05T09:55:12.990Z` |
| 访问状态 | 成功（`ok: true`） |
| HTTP 状态 | `200` |
| 标题（source.json） | Overview of HTTP - HTTP \| MDN |
| 正文标题（快照 H1） | Overview of HTTP |
| 内容类型 | text/html |
| 原始 HTML 字节数 | 228528 |
| 原始 HTML SHA-256 | `7d755b86288f764c17fd0e58005b1c2ce73609439c817a2f5095e03ef415e0db` |
| 来源快照 | `inputs/01-MDN-HTTP-指南/page.md` |
| 来源快照 SHA-256 | `8fd966d10cf3b7e3d80a2ca97787b81cb83996d5d508f1345917f2e6829a5774` |
| 内容摘要 | 介绍 HTTP 的客户端—服务器模型、代理、可扩展与无状态特性、连接、HTTP 消息、基于 HTTP 的 API 与延伸阅读；正文包含 2 个 HTTP 报文示例代码块。 |
| 源快照结构统计 | 标题 19；表格 0；代码块 2；链接 63；图片 5 |

---

<!-- BEGIN VERBATIM SNAPSHOT BODY: inputs/01-MDN-HTTP-指南/page.md -->
# Overview of HTTP

**HTTP** is a [protocol](https://developer.mozilla.org/en-US/docs/Glossary/Protocol) for fetching resources such as HTML documents. It is the foundation of any data exchange on the Web and it is a client-server protocol, which means requests are initiated by the recipient, usually the Web browser. A complete document is typically constructed from resources such as text content, layout instructions, images, videos, scripts, and more.

![A single Web document composed from multiple resources from different servers.](https://mdn.github.io/shared-assets/images/diagrams/http/overview/fetching-a-page.svg)

Clients and servers communicate by exchanging individual messages (as opposed to a stream of data). The messages sent by the client are called _requests_ and the messages sent by the server as an answer are called _responses_.

![HTTP as an application layer protocol, on top of TCP (transport layer) and IP (network layer) and below the presentation layer.](https://mdn.github.io/shared-assets/images/diagrams/http/overview/http-layers.svg)

Designed in the early 1990s, HTTP is an extensible protocol which has evolved over time. It is an application layer protocol that is sent over [TCP](https://developer.mozilla.org/en-US/docs/Glossary/TCP), or over a [TLS](https://developer.mozilla.org/en-US/docs/Glossary/TLS)\-encrypted TCP connection, though any reliable transport protocol could theoretically be used. Due to its extensibility, it is used to not only fetch hypertext documents, but also images and videos or to post content to servers, like with HTML form results. HTTP can also be used to fetch parts of documents to update Web pages on demand.

## [Components of HTTP-based systems](#components_of_http-based_systems)

HTTP is a client-server protocol: requests are sent by one entity, the user-agent (or a proxy on behalf of it). Most of the time the user-agent is a Web browser, but it can be anything, for example, a robot that crawls the Web to populate and maintain a search engine index.

Each individual request is sent to a server, which handles it and provides an answer called the _response_. Between the client and the server there are numerous entities, collectively called [proxies](https://developer.mozilla.org/en-US/docs/Glossary/Proxy_server), which perform different operations and act as gateways or [caches](https://developer.mozilla.org/en-US/docs/Glossary/Cache), for example.

![An HTTP request from a client forwarded by several proxies to a server and a response taking the same route back to the client.](https://mdn.github.io/shared-assets/images/diagrams/http/overview/client-server-chain.svg)

In reality, there are more computers between a browser and the server handling the request: there are routers, modems, and more. Thanks to the layered design of the Web, these are hidden in the network and transport layers. HTTP is on top, at the application layer. Although important for diagnosing network problems, the underlying layers are mostly irrelevant to the description of HTTP.

### [Client: the user-agent](#client_the_user-agent)

The _user-agent_ is any tool that acts on behalf of the user. This role is primarily performed by the Web browser, but it may also be performed by programs used by engineers and Web developers to debug their applications.

The browser is **always** the entity initiating the request. It is never the server (though some mechanisms have been added over the years to simulate server-initiated messages).

To display a Web page, the browser sends an original request to fetch the HTML document that represents the page. It then parses this file, making additional requests corresponding to execution scripts, layout information (CSS) to display, and sub-resources contained within the page (usually images and videos). The Web browser then combines these resources to present the complete document, the Web page. Scripts executed by the browser can fetch more resources in later phases and the browser updates the Web page accordingly.

A Web page is a hypertext document. This means some parts of the displayed content are links, which can be activated (usually by a click of the mouse) to fetch a new Web page, allowing the user to direct their user-agent and navigate through the Web. The browser translates these directions into HTTP requests, and further interprets the HTTP responses to present the user with a clear response.

### [The Web server](#the_web_server)

On the opposite side of the communication channel is the server, which _serves_ the document as requested by the client. A server appears as only a single machine virtually; but it may actually be a collection of servers sharing the load (load balancing), or other software (such as caches, a database server, or e-commerce servers), totally or partially generating the document on demand.

A server is not necessarily a single machine, but several server software instances can be hosted on the same machine. With HTTP/1.1 and the [`Host`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Host) header, they may even share the same IP address.

### [Proxies](#proxies)

Between the Web browser and the server, numerous computers and machines relay the HTTP messages. Due to the layered structure of the Web stack, most of these operate at the transport, network or physical levels, becoming transparent at the HTTP layer and potentially having a significant impact on performance. Those operating at the application layers are generally called **proxies**. These can be transparent, forwarding on the requests they receive without altering them in any way, or non-transparent, in which case they will change the request in some way before passing it along to the server. Proxies may perform numerous functions:

-   caching (the cache can be public or private, like the browser cache)
-   filtering (like an antivirus scan or parental controls)
-   load balancing (to allow multiple servers to serve different requests)
-   authentication (to control access to different resources)
-   logging (allowing the storage of historical information)

## [Basic aspects of HTTP](#basic_aspects_of_http)

### [HTTP is simple](#http_is_simple)

HTTP is generally designed to be human-readable, even with the added complexity introduced in HTTP/2 by encapsulating HTTP messages into frames. HTTP messages can be read and understood by humans, providing easier testing for developers, and reduced complexity for newcomers.

### [HTTP is extensible](#http_is_extensible)

Introduced in HTTP/1.0, [HTTP headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers) make this protocol easy to extend and experiment with. New functionality can even be introduced by an agreement between a client and a server about a new header's semantics.

### [HTTP is stateless, but not sessionless](#http_is_stateless_but_not_sessionless)

HTTP is stateless: there is no link between two requests being successively carried out on the same connection. This immediately has the prospect of being problematic for users attempting to interact with certain pages coherently, for example, using e-commerce shopping baskets. But while the core of HTTP itself is stateless, HTTP cookies allow the use of stateful sessions. Using header extensibility, HTTP Cookies are added to the workflow, allowing session creation on each HTTP request to share the same context, or the same state.

### [HTTP and connections](#http_and_connections)

A connection is controlled at the transport layer, and therefore fundamentally out of scope for HTTP. HTTP doesn't require the underlying transport protocol to be connection-based; it only requires it to be _reliable_, or not lose messages (at minimum, presenting an error in such cases). Among the two most common transport protocols on the Internet, TCP is reliable and UDP isn't. HTTP therefore relies on the TCP standard, which is connection-based.

Before a client and server can exchange an HTTP request/response pair, they must establish a TCP connection, a process which requires several round-trips. The default behavior of HTTP/1.0 is to open a separate TCP connection for each HTTP request/response pair. This is less efficient than sharing a single TCP connection when multiple requests are sent in close succession.

In order to mitigate this flaw, HTTP/1.1 introduced _pipelining_ (which proved difficult to implement) and _persistent connections_: the underlying TCP connection can be partially controlled using the [`Connection`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Connection) header. HTTP/2 went a step further by multiplexing messages over a single connection, helping keep the connection warm and more efficient.

Experiments are in progress to design a better transport protocol more suited to HTTP. For example, Google is experimenting with [QUIC](https://en.wikipedia.org/wiki/QUIC "External link (opens in new tab)") which builds on UDP to provide a more reliable and efficient transport protocol.

## [What can be controlled by HTTP](#what_can_be_controlled_by_http)

This extensible nature of HTTP has, over time, allowed for more control and functionality of the Web. Cache and authentication methods were functions handled early in HTTP history. The ability to relax the _origin constraint_, by contrast, was only added in the 2010s.

Here is a list of common features controllable with HTTP:

-   _[Caching](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching)_: How documents are cached can be controlled by HTTP. The server can instruct proxies and clients about what to cache and for how long. The client can instruct intermediate cache proxies to ignore the stored document.
-   _Relaxing the origin constraint_: To prevent snooping and other privacy invasions, Web browsers enforce strict separation between websites. Only pages from the **same origin** can access all the information of a Web page. Though such a constraint is a burden to the server, HTTP headers can relax this strict separation on the server side, allowing a document to become a patchwork of information sourced from different domains; there could even be security-related reasons to do so.
-   _Authentication_: Some pages may be protected so that only specific users can access them. Basic authentication may be provided by HTTP, either using the [`WWW-Authenticate`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/WWW-Authenticate) and similar headers, or by setting a specific session using [HTTP cookies](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies).
-   _[Proxy and tunneling](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Proxy_servers_and_tunneling)_: Servers or clients are often located on intranets and hide their true IP address from other computers. HTTP requests then go through proxies to cross this network barrier. Not all proxies are HTTP proxies. The SOCKS protocol, for example, operates at a lower level. Other protocols, like FTP, can be handled by these proxies.
-   _Sessions_: Using HTTP cookies allows you to link requests with the state of the server. This creates sessions, despite basic HTTP being a state-less protocol. This is useful not only for e-commerce shopping baskets, but also for any site allowing user configuration of the output.

## [HTTP flow](#http_flow)

When a client wants to communicate with a server, either the final server or an intermediate proxy, it performs the following steps:

1.  Open a TCP connection: The TCP connection is used to send a request, or several, and receive an answer. The client may open a new connection, reuse an existing connection, or open several TCP connections to the servers.

2.  Send an HTTP message: HTTP messages (before HTTP/2) are human-readable. With HTTP/2, these messages are encapsulated in frames, making them impossible to read directly, but the principle remains the same. For example:

    http

    ```
    GET / HTTP/1.1
    Host: developer.mozilla.org
    Accept-Language: fr
    ```

3.  Read the response sent by the server, such as:

    http

    ```
    HTTP/1.1 200 OK
    Date: Sat, 09 Oct 2010 14:28:02 GMT
    Server: Apache
    Last-Modified: Tue, 01 Dec 2009 20:18:22 GMT
    ETag: "51142bc1-7449-479b075b2891b"
    Accept-Ranges: bytes
    Content-Length: 29769
    Content-Type: text/html

    <!doctype html>… (here come the 29769 bytes of the requested web page)
    ```

4.  Close or reuse the connection for further requests.


If HTTP pipelining is activated, several requests can be sent without waiting for the first response to be fully received. HTTP pipelining has proven difficult to implement in existing networks, where old pieces of software coexist with modern versions. HTTP pipelining has been superseded in HTTP/2 with more robust multiplexing requests within a frame.

## [HTTP Messages](#http_messages)

HTTP messages, as defined in HTTP/1.1 and earlier, are human-readable. In HTTP/2, these messages are embedded into a binary structure, a _frame_, allowing optimizations like compression of headers and multiplexing. Even if only part of the original HTTP message is sent in this version of HTTP, the semantics of each message is unchanged and the client reconstitutes (virtually) the original HTTP/1.1 request. It is therefore useful to comprehend HTTP/2 messages in the HTTP/1.1 format.

There are two types of HTTP messages, requests and responses, each with its own format.

### [Requests](#requests)

An example HTTP request:

![Overview of an HTTP GET request with headers](https://mdn.github.io/shared-assets/images/diagrams/http/overview/http-request.svg)

Requests consist of the following elements:

-   An HTTP [method](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Methods), usually a verb like [`GET`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Methods/GET), [`POST`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Methods/POST), or a noun like [`OPTIONS`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Methods/OPTIONS) or [`HEAD`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Methods/HEAD) that defines the operation the client wants to perform. Typically, a client wants to fetch a resource (using `GET`) or post the value of an [HTML form](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Forms) (using `POST`), though more operations may be needed in other cases.
-   The path of the resource to fetch; the URL of the resource stripped from elements that are obvious from the context, for example without the [protocol](https://developer.mozilla.org/en-US/docs/Glossary/Protocol) (`http://`), the [domain](https://developer.mozilla.org/en-US/docs/Glossary/Domain) (here, `developer.mozilla.org`), or the TCP [port](https://developer.mozilla.org/en-US/docs/Glossary/Port) (here, `80`).
-   The version of the HTTP protocol.
-   Optional [headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers) that convey additional information for the servers.
-   A body, for some methods like `POST`, similar to those in responses, which contain the resource sent.

### [Responses](#responses)

An example response:

![Overview of a '200 OK' HTTP response to a GET request including response headers.](https://mdn.github.io/shared-assets/images/diagrams/http/overview/http-response.svg)

Responses consist of the following elements:

-   The version of the HTTP protocol they follow.
-   A [status code](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status), indicating if the request was successful or not, and why.
-   A status message, a non-authoritative short description of the status code.
-   HTTP [headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers), like those for requests.
-   Optionally, a body containing the fetched resource.

## [APIs based on HTTP](#apis_based_on_http)

The most commonly used API based on HTTP is the [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API), which can be used to make HTTP requests from JavaScript. The Fetch API replaces the [`XMLHttpRequest`](https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest) API.

Another API, [server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events), is a one-way service that allows a server to send events to the client, using HTTP as a transport mechanism. Using the [`EventSource`](https://developer.mozilla.org/en-US/docs/Web/API/EventSource) interface, the client opens a connection and establishes event handlers. The client browser automatically converts the messages that arrive on the HTTP stream into appropriate [`Event`](https://developer.mozilla.org/en-US/docs/Web/API/Event) objects. Then it delivers them to the event handlers that have been registered for the events' [`type`](https://developer.mozilla.org/en-US/docs/Web/API/Event/type "type") if known, or to the [`onmessage`](https://developer.mozilla.org/en-US/docs/Web/API/EventSource/message_event "onmessage") event handler if no type-specific event handler was established.

## [Conclusion](#conclusion)

HTTP is an extensible protocol that is easy to use. The client-server structure, combined with the ability to add headers, allows HTTP to advance along with the extended capabilities of the Web.

Though HTTP/2 adds some complexity by embedding HTTP messages in frames to improve performance, the basic structure of messages has stayed the same since HTTP/1.0. Session flow remains basic, allowing it to be investigated and debugged with an [HTTP network monitor](https://firefox-source-docs.mozilla.org/devtools-user/network_monitor/index.html "External link (opens in new tab)").

## [See also](#see_also)

-   [Evolution of HTTP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Evolution_of_HTTP)
-   Glossary terms:
    -   [HTTP](https://developer.mozilla.org/en-US/docs/Glossary/HTTP)
    -   [HTTP/2](https://developer.mozilla.org/en-US/docs/Glossary/HTTP_2)
    -   [QUIC](https://developer.mozilla.org/en-US/docs/Glossary/QUIC)

## Help improve MDN

[Learn how to contribute](https://developer.mozilla.org/en-US/docs/MDN/Community/Getting_started)

This page was last modified on Oct 8, 2026 by [MDN contributors](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Overview/contributors.txt).

[View this page on GitHub](https://github.com/mdn/content/blob/main/files/en-us/web/http/guides/overview/index.md?plain=1 "Folder: en-us/web/http/guides/overview (Opens in a new tab)") • [Report a problem with this content](https://github.com/mdn/content/issues/new?template=page-report.yml&mdn-url=https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2Fdocs%2FWeb%2FHTTP%2FGuides%2FOverview&metadata=%3C%21--+Do+not+make+changes+below+this+line+--%3E%0A%3Cdetails%3E%0A%3Csummary%3EPage+report+details%3C%2Fsummary%3E%0A%0A*+Folder%3A+%60en-us%2Fweb%2Fhttp%2Fguides%2Foverview%60%0A*+MDN+URL%3A+https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2Fdocs%2FWeb%2FHTTP%2FGuides%2FOverview%0A*+GitHub+URL%3A+https%3A%2F%2Fgithub.com%2Fmdn%2Fcontent%2Fblob%2Fmain%2Ffiles%2Fen-us%2Fweb%2Fhttp%2Fguides%2Foverview%2Findex.md%0A*+Last+commit%3A+https%3A%2F%2Fgithub.com%2Fmdn%2Fcontent%2Fcommit%2Fa3400c39a245e0404c621c2cdbe75ad0a3eb8672%0A*+Document+last+modified%3A+2026-10-08T04%3A16%3A32.000Z%0A%0A%3C%2Fdetails%3E "This will take you to GitHub to file a new issue.")

<!-- END VERBATIM SNAPSHOT BODY: inputs/01-MDN-HTTP-指南/page.md -->

---

## 来源 JSON 快照

```json
{
  "requestedUrl": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Overview",
  "finalUrl": "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Overview",
  "fetchedAt": "2026-11-05T09:55:12.990Z",
  "status": 200,
  "contentType": "text/html",
  "title": "Overview of HTTP - HTTP | MDN",
  "bytes": 228528,
  "sha256": "7d755b86288f764c17fd0e58005b1c2ce73609439c817a2f5095e03ef415e0db",
  "ok": true
}
```
