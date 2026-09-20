

I want to rearchiecture this bankGPT project right now. 

The user will now take the user request - written in natural language and map it to one of the allowed actions. Two requests may map to the same allowed action and the same recipe. eg. i. Tell me my saving account balance 
            ii. Retrieve my savings balance money 
            iii. What is my current savings balance?
            iv. I want to know my checking account balance
            v. What is my total balance in all my accounts?

All of the above user requests should map to the same allowed action "retrieve bank details" and they should have the same recipe.

The recipe should be able to handle all of the above user requests. 

The way the recipe should work is that we parse and process the user request and extract parameters which we pass to the recipe. The recipe will then use these parameters to complete the task--using different branches of the recipe to handle different user requests. One of the ways we can make this work is by retrieving all of the bank account ballance details and then using the user request and appending the retrieved information as context and passing it to the LLM to generate the appropriate response.

For retrieval requests, we lean heavily (we are biased towards) retrieving the entire information that could be helpful and guauging the final result using the user request at the final 'User Request Processing Layer'. So, for retrieval requests, we expose only the allowed action to the LLM when we are creating the recipe since we want to ensure that the LLM retrieves generalised information rather than being influenced by the specific user request.

eg. 
User request: "Tell me my saving account balance"
Allowed action: "retrieve bank account balance details"
Recipe: "retrieve_bank_account_balance_details_ngpf.org_recipe.ts" -->
    {
        "checking_account_balance": $55.5,
        "savings_account_balance": $120.0
    }
Final prompt to LLM: 
User request: "Tell me my saving account balance"
Context: 
    {
        "checking_account_balance": $55.5,
        "savings_account_balance": $120.0
    }
Final response from LLM: "$120.0"

I am proposing the following layers:

--User request 
    |
    |
    ----> AllowedListScreening Layer: In this layer, we will check if the user request is in the allowed list of actions. If it is not in the allowed list, we will escalate to a human agent. If it is in the allowed list, we will move to the next layer.
    |
    |
    ----> Recipe Mapping Layer: In this layer, we will map the user request to a specific recipe. We will also extract parameters from the user request and pass them to the recipe. The recipe will then use these parameters to complete the task.
    |
    |
    ----> Recipe Making Layer: In this layer, we will create a recipe to complete the task. The recipe will be a series of steps that the AI agent will take to complete the task. The recipe will be stored in a cache for future use. We can name the recipe file as <allowed_action>_website_domain_recipe.ts>
    |
    |
    ----> Recipe Execution Layer: In this layer, we will execute the stored cached "recipe" to complete the task. We will record it as a success if we have all the necessary information that proves that the task was completed. Example, if the task was to retrieve saving bank balance number we should have a number that is not null. The recipe will need "ingredients"-- this is the information about the user request that will map it to some branch of the recipe. The recipe will be able to handle different user requests by using different branches of the recipe.
    |
    |
    ----> User Request Processing Layer: In this layer, if user request is the retrievel of information we take the response from the recipe and give to the LLM along with the original user request and allow the LLM to generate the final response for the user.
